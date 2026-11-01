/**
 * @license
 * Copyright 2026 Cai Lab
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A soft refresh reads the chunks of a source again WITHOUT taking away what
 * the source shows: the chunk on screen stays until the new data for the same
 * key has arrived, and is then replaced in one step. The invalidation that
 * exists already (`invalidateSourceCache`) empties the whole source first and
 * is left as it is; this module is the other path only.
 *
 * Nothing here knows about the worker or the frontend. The worker supplies the
 * operations (read, swap, evict) and this module decides the order, the
 * re-read rule and the failure handling.
 */

import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";

/** The part of a backend chunk that planning looks at. */
export interface ShownChunk {
  key?: string | null;
  state: ChunkState;
  priorityTier: ChunkPriorityTier;
  priority: number;
}

export interface RefreshPlan<C> {
  /** Chunks that are on screen (or about to be): read again, replaced in place. */
  refresh: C[];
  /** Chunks that are only cached: dropped, as the existing invalidation does. */
  evict: C[];
}

function nearestFirst(a: ShownChunk, b: ShownChunk) {
  if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier;
  if (a.priority > b.priority) return -1;
  if (a.priority < b.priority) return 1;
  return 0;
}

/**
 * Splits the chunks of a source into those worth replacing in place and those
 * that are simply dropped. A chunk is worth replacing when the frontend holds
 * it on the GPU for a view that is asking for it now (VISIBLE) or soon
 * (PREFETCH). Everything that holds data in some other place is dropped, and
 * its next read starts from nothing, as it does for the whole source today.
 * A chunk that has no data yet (NEW) needs neither.
 */
export function planRefresh<C extends ShownChunk>(
  chunks: Iterable<C>,
): RefreshPlan<C> {
  const refresh: C[] = [];
  const evict: C[] = [];
  for (const chunk of chunks) {
    if (chunk.state === ChunkState.NEW) continue;
    if (
      chunk.state === ChunkState.GPU_MEMORY &&
      chunk.priorityTier !== ChunkPriorityTier.RECENT
    ) {
      refresh.push(chunk);
    } else {
      evict.push(chunk);
    }
  }
  refresh.sort(nearestFirst);
  return { refresh, evict };
}

export interface RefreshOps<C, F> {
  /** Reads the chunk's data again into something that is not part of the cache. */
  readFresh(chunk: C, signal: AbortSignal): Promise<F>;
  isEmpty(fresh: F): boolean;
  /** Whether the chunk on screen has data, so that an empty answer is suspect. */
  hadData(chunk: C): boolean;
  /** Whether the chunk is still the one the cache holds, on the GPU. */
  isCurrent(chunk: C): boolean;
  /** Replaces the chunk on screen with the fresh data, in one step. */
  swap(chunk: C, fresh: F): void;
  /** Drops the chunk the way the existing invalidation does. */
  fallBack(chunk: C): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export interface RefreshOptions {
  signal: AbortSignal;
  /** Chunks read at the same time by this call. */
  concurrency: number;
  /** Pause before a second read of a chunk that came back empty. */
  rereadDelayMs: number;
}

export interface RefreshOutcome {
  refreshed: number;
  /** Chunks left alone: gone from the cache, or the refresh was cancelled. */
  skipped: number;
  /** Chunks whose read failed; each of them was dropped with `fallBack`. */
  failed: number;
}

/**
 * Refreshes `chunks` in the order given, `options.concurrency` at a time.
 *
 * A chunk that had data and comes back empty is read once more after a pause:
 * the storage may not show a write that has just finished (a chunk that is
 * missing for good is read twice, the price of not showing a hole). A chunk
 * that never had data is read once, since most of what a view shows was never
 * written. Two empty answers are accepted as the truth.
 *
 * Only a chunk that is still current after its read is replaced. A read that
 * fails drops that chunk alone, so the normal queue reads it from scratch.
 */
export async function runRefresh<C, F>(
  chunks: readonly C[],
  ops: RefreshOps<C, F>,
  options: RefreshOptions,
): Promise<RefreshOutcome> {
  const { signal, rereadDelayMs } = options;
  const outcome: RefreshOutcome = { refreshed: 0, skipped: 0, failed: 0 };

  async function refreshOne(chunk: C) {
    if (signal.aborted || !ops.isCurrent(chunk)) {
      ++outcome.skipped;
      return;
    }
    try {
      const hadData = ops.hadData(chunk);
      let fresh = await ops.readFresh(chunk, signal);
      if (hadData && ops.isEmpty(fresh)) {
        await ops.wait(rereadDelayMs, signal);
        fresh = await ops.readFresh(chunk, signal);
      }
      if (signal.aborted || !ops.isCurrent(chunk)) {
        ++outcome.skipped;
        return;
      }
      ops.swap(chunk, fresh);
      ++outcome.refreshed;
    } catch {
      if (signal.aborted || !ops.isCurrent(chunk)) {
        ++outcome.skipped;
        return;
      }
      ops.fallBack(chunk);
      ++outcome.failed;
    }
  }

  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      await refreshOne(chunks[next++]);
    }
  }
  const workers = Math.min(Math.max(1, options.concurrency), chunks.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return outcome;
}

/** The part of a frontend chunk source that `putChunk` uses. */
export interface ChunkCache<C> {
  chunks: Map<string, C>;
  deleteChunk(key: string): void;
  addChunk(key: string, chunk: C): void;
}

/**
 * Adds a chunk to the frontend cache. A chunk that already has that key (the
 * one a soft refresh is replacing) goes first, through the cache's own delete,
 * so that its GPU memory is freed; for a key that is new this is `addChunk`.
 */
export function putChunk<C>(cache: ChunkCache<C>, key: string, chunk: C) {
  if (cache.chunks.has(key)) {
    cache.deleteChunk(key);
  }
  cache.addChunk(key, chunk);
}

/**
 * Keeps the replacements of a soft refresh back until the page says they may
 * be shown, so that everything the refresh replaces changes in one frame: the
 * frame in which the draft layer is hidden. Without it each replacement is
 * drawn as it arrives, and a stroke is drawn twice (by the committed layer,
 * which already has it, and by the draft) until the rest has arrived.
 *
 * While a hold is active a replacement is kept, and so is every later update
 * of the same source, so that the updates of a source are applied in the order
 * the worker sent them: a replacement followed by an eviction of the same
 * chunk must not be applied the other way round.
 */
export class UpdateHold<S, U extends { refresh?: boolean }> {
  private holds = 0;
  private held: U[] = [];
  private heldSources = new Set<S>();

  begin() {
    ++this.holds;
  }

  /** Whether `update` was kept; if not, it is applied as usual. */
  keep(source: S, update: U): boolean {
    if (this.holds === 0) return false;
    if (update.refresh !== true && !this.heldSources.has(source)) return false;
    this.heldSources.add(source);
    this.held.push(update);
    return true;
  }

  /** Ends one hold. The last one gives back the kept updates, in the order they arrived. */
  end(): U[] {
    if (this.holds === 0) return [];
    if (--this.holds > 0) return [];
    const held = this.held;
    this.held = [];
    this.heldSources.clear();
    return held;
  }
}

/** A fixed number of slots, handed out first come, first served. */
export class Slots {
  private free: number;
  private waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  /** Resolves with the function that gives the slot back. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.free > 0) {
      --this.free;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(turn);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      this.waiting.push(turn);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.releaseOnce();
  }

  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const turn = this.waiting.shift();
      if (turn === undefined) {
        ++this.free;
      } else {
        turn();
      }
    };
  }
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
