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
 * The worker side of a soft refresh: `ChunkQueueManager.refreshSourceCache`.
 * `soft_refresh.spec.ts` covers the decisions (what to refresh, when to read
 * again, how to fail); these tests cover what the worker does with them: which
 * chunks are dropped, which are replaced, and that no chunk is left holding
 * data the refresh was meant to replace.
 *
 * The queue manager is built without its RPC: the two methods that talk to the
 * frontend and the queues (`evictChunk`, `sendFreshChunk`) are replaced by
 * recorders, since what they do is not what is tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import { Slots } from "#src/chunk_manager/soft_refresh.js";

type FakeChunk = {
  key: string;
  state: ChunkState;
  priorityTier: ChunkPriorityTier;
  priority: number;
  gpuMemoryBytes: number;
};
type Fresh = { key: string; empty: boolean; tag: string };

function chunk(
  key: string,
  state = ChunkState.GPU_MEMORY,
  priorityTier = ChunkPriorityTier.VISIBLE,
  priority = 0,
  gpuMemoryBytes = 100,
): FakeChunk {
  return { key, state, priorityTier, priority, gpuMemoryBytes };
}

/** A source holding `chunks`; `reads` decides what a read of a chunk answers. */
function makeSource(
  chunks: FakeChunk[],
  reads: (
    c: FakeChunk,
    attempt: number,
    signal: AbortSignal,
  ) => Promise<Fresh> | Fresh = (c) => ({
    key: c.key,
    empty: false,
    tag: `${c.key}-new`,
  }),
) {
  const attempts = new Map<string, number>();
  return {
    chunks: new Map(chunks.map((c) => [c.key, c])),
    readFresh: vi.fn(async (c: FakeChunk, signal: AbortSignal) => {
      const attempt = (attempts.get(c.key) ?? 0) + 1;
      attempts.set(c.key, attempt);
      return reads(c, attempt, signal);
    }),
    isFreshEmpty: (fresh: Fresh) => fresh.empty,
    freshBytes: (fresh: Fresh) => (fresh.empty ? 0 : 100),
  };
}

function makeQueue() {
  const queue = Object.create(ChunkQueueManager.prototype) as any;
  queue.refreshSlots = new Slots(16);
  queue.refreshGenerations = new WeakMap();
  queue.evicted = [] as string[];
  queue.sent = [] as string[];
  queue.evictChunk = vi.fn((c: FakeChunk) => {
    queue.evicted.push(c.key);
    c.state = ChunkState.QUEUED;
  });
  queue.sendFreshChunk = vi.fn((c: FakeChunk, fresh: Fresh, bytes: number) => {
    queue.sent.push(`${c.key} <- ${fresh.tag}`);
    c.gpuMemoryBytes = bytes;
  });
  queue.invalidateSourceCache = vi.fn();
  return queue as {
    refreshSourceCache(source: any, signal: AbortSignal): Promise<any>;
    evicted: string[];
    sent: string[];
    evictChunk: ReturnType<typeof vi.fn>;
    sendFreshChunk: ReturnType<typeof vi.fn>;
    invalidateSourceCache: ReturnType<typeof vi.fn>;
  };
}

const signal = () => new AbortController().signal;

/** A read that never answers, and fails when it is cancelled, as a fetch does. */
const hang = (signal: AbortSignal) =>
  new Promise<Fresh>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ChunkQueueManager.refreshSourceCache", () => {
  it("replaces the chunks on screen with their new data, and drops the ones that are only cached", async () => {
    const queue = makeQueue();
    const near = chunk(
      "near",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.VISIBLE,
      -1,
    );
    const prefetched = chunk(
      "prefetched",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.PREFETCH,
      -2,
    );
    const cached = chunk(
      "cached",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.RECENT,
    );
    const inMemory = chunk(
      "in-memory",
      ChunkState.SYSTEM_MEMORY,
      ChunkPriorityTier.VISIBLE,
    );
    const source = makeSource([near, prefetched, cached, inMemory]);

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    const result = await running;

    expect(queue.sent.sort()).toEqual([
      "near <- near-new",
      "prefetched <- prefetched-new",
    ]);
    expect(queue.evicted.sort()).toEqual(["cached", "in-memory"]);
    expect(result).toEqual({
      refreshed: 2,
      skipped: 0,
      failed: 0,
      fellBack: false,
    });
  });

  it("hands the new size to the chunk it replaces", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const source = makeSource([a], (c) => ({
      key: c.key,
      empty: false,
      tag: "new",
    }));

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await running;

    expect(queue.sendFreshChunk).toHaveBeenCalledWith(
      a,
      expect.objectContaining({ tag: "new" }),
      100,
    );
  });

  it("invalidates the whole source when it cannot read a chunk into a spare object", async () => {
    const queue = makeQueue();
    const source = { chunks: new Map([["a", chunk("a")]]) };

    const result = await queue.refreshSourceCache(source, signal());

    expect(queue.invalidateSourceCache).toHaveBeenCalledWith(source);
    expect(queue.evictChunk).not.toHaveBeenCalled();
    expect(queue.sendFreshChunk).not.toHaveBeenCalled();
    expect(result).toEqual({
      refreshed: 0,
      skipped: 0,
      failed: 0,
      fellBack: true,
    });
  });

  it("drops a chunk whose read failed and replaces the others", async () => {
    const queue = makeQueue();
    const source = makeSource([chunk("a"), chunk("b"), chunk("c")], (c) => {
      if (c.key === "b") throw new Error("network");
      return { key: c.key, empty: false, tag: `${c.key}-new` };
    });

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    const result = await running;

    expect(queue.evicted).toEqual(["b"]);
    expect(queue.sent.sort()).toEqual(["a <- a-new", "c <- c-new"]);
    expect(result).toMatchObject({ refreshed: 2, failed: 1 });
  });

  it("reads a chunk that had data again when the first answer is empty, and replaces it with the second", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const source = makeSource([a], (c, attempt) =>
      attempt === 1
        ? { key: c.key, empty: true, tag: "empty" }
        : { key: c.key, empty: false, tag: "second" },
    );

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await running;

    expect(source.readFresh).toHaveBeenCalledTimes(2);
    expect(queue.sent).toEqual(["a <- second"]);
  });

  it("reads a chunk that never had data once", async () => {
    const queue = makeQueue();
    const never = chunk(
      "never",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.VISIBLE,
      0,
      0,
    );
    const source = makeSource([never], (c) => ({
      key: c.key,
      empty: true,
      tag: "empty",
    }));

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await running;

    expect(source.readFresh).toHaveBeenCalledTimes(1);
    expect(queue.sent).toEqual(["never <- empty"]);
  });

  it("drops a chunk that left GPU memory while its data was being read, so its old data does not come back", async () => {
    // The cache moved the chunk to system memory (the frontend keeps its old
    // data there) after the read began. Replacing it is no longer possible,
    // and leaving it would show the old data the next time it is promoted.
    const queue = makeQueue();
    const a = chunk("a");
    const source = makeSource([a], (c) => {
      a.state = ChunkState.SYSTEM_MEMORY;
      return { key: c.key, empty: false, tag: "late" };
    });

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    const result = await running;

    expect(queue.sent).toEqual([]);
    expect(queue.evicted).toEqual(["a"]);
    expect(result).toMatchObject({ refreshed: 0, skipped: 1 });
  });

  it("leaves a chunk alone that was already queued again by the cache while it was read", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const source = makeSource([a], (c) => {
      a.state = ChunkState.QUEUED;
      return { key: c.key, empty: false, tag: "late" };
    });

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await running;

    expect(queue.sent).toEqual([]);
    expect(
      queue.evicted,
      "a queued chunk holds no data and is read again by the queue",
    ).toEqual([]);
  });

  it("leaves a chunk object alone that was recycled for another key while it was read", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const source = makeSource([a], (c) => {
      // the object now belongs to another key of the same source
      source.chunks.delete("a");
      a.key = "other";
      source.chunks.set("other", a);
      return { key: c.key, empty: false, tag: "late" };
    });

    const running = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await running;

    expect(queue.sent, "data read for one key was put into another").toEqual(
      [],
    );
    expect(queue.evicted).toEqual([]);
  });

  it("drops every chunk it did not replace when it is cancelled", async () => {
    const queue = makeQueue();
    const controller = new AbortController();
    const chunks = [chunk("a"), chunk("b")];
    const source = makeSource(chunks, (_c, _attempt, signal) => hang(signal));

    const running = queue.refreshSourceCache(source, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await vi.runAllTimersAsync();
    const result = await running;

    // nothing was put on screen, and nothing keeps its old data
    expect(queue.sent).toEqual([]);
    expect(queue.evicted.sort()).toEqual(["a", "b"]);
    expect(result).toMatchObject({ refreshed: 0, failed: 0 });
  });

  it("keeps what it replaced when it is cancelled, and drops only the rest", async () => {
    const queue = makeQueue();
    const controller = new AbortController();
    const source = makeSource(
      [chunk("a"), chunk("b")],
      (c, _attempt, signal) =>
        c.key === "a"
          ? { key: c.key, empty: false, tag: "done" }
          : hang(signal),
    );

    const running = queue.refreshSourceCache(source, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await vi.runAllTimersAsync();
    await running;

    expect(queue.sent).toEqual(["a <- done"]);
    expect(queue.evicted).toEqual(["b"]);
  });

  it("steps aside for a newer refresh of the same source: neither swaps nor drops what the newer one owns", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const b = chunk("b");
    const olderReads: ((fresh: Fresh) => void)[] = [];
    // the first refresh's two reads wait; the second refresh's answer at once
    let calls = 0;
    const source = makeSource([a, b], (c) => {
      calls++;
      if (calls <= 2) {
        return new Promise<Fresh>((resolve) => olderReads.push(resolve));
      }
      return { key: c.key, empty: false, tag: "newer" };
    });

    const older = queue.refreshSourceCache(source, signal());
    await vi.advanceTimersByTimeAsync(10);
    const newer = queue.refreshSourceCache(source, signal());
    await vi.runAllTimersAsync();
    await newer;
    olderReads.forEach((resolve) =>
      resolve({ key: "x", empty: false, tag: "older" }),
    );
    await vi.runAllTimersAsync();
    await older;

    expect(queue.sent.sort()).toEqual(["a <- newer", "b <- newer"]);
    expect(
      queue.evicted,
      "the older refresh dropped chunks the newer one replaced",
    ).toEqual([]);
  });
});

describe("ChunkQueueManager.sendFreshChunk", () => {
  function sender() {
    const invoked: { name: string; msg: any; transfers: any[] }[] = [];
    const queue = Object.create(ChunkQueueManager.prototype) as any;
    queue.rpc = {
      invoke: (name: string, msg: any, transfers: any[]) =>
        invoked.push({ name, msg, transfers }),
    };
    queue.gpuMemoryGeneration = 0;
    queue.scheduleUpdate = vi.fn();
    return { queue, invoked };
  }

  it("sends the new chunk as a replacement the frontend can hold back, in GPU memory", () => {
    const { queue, invoked } = sender();
    const old = { systemMemoryBytes: 1, gpuMemoryBytes: 1 };
    const buffer = new ArrayBuffer(8);
    const fresh = {
      serialize(msg: any, transfers: any[]) {
        msg.id = "k";
        msg.source = 7;
        msg.new = true;
        transfers.push(buffer);
      },
    };

    queue.sendFreshChunk(old, fresh, 64);

    expect(invoked).toHaveLength(1);
    expect(invoked[0].name).toBe("Chunk.update");
    // `refresh` is what lets the frontend keep it back until the page says so
    expect(invoked[0].msg).toMatchObject({
      id: "k",
      source: 7,
      new: true,
      state: ChunkState.GPU_MEMORY,
      refresh: true,
    });
    expect(invoked[0].transfers).toEqual([buffer]);
  });

  it("gives the chunk it replaces the size of the new data, and tells the queue", () => {
    const { queue } = sender();
    const old = { systemMemoryBytes: 1, gpuMemoryBytes: 1 };

    queue.sendFreshChunk(old, { serialize() {} }, 64);

    expect(old).toEqual({ systemMemoryBytes: 64, gpuMemoryBytes: 64 });
    expect(queue.gpuMemoryGeneration).toBe(1);
    expect(queue.scheduleUpdate).toHaveBeenCalled();
  });
});
