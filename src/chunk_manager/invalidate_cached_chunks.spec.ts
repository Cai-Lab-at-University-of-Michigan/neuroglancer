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
 * `ChunkQueueManager.invalidateCachedChunks`: some chunks of a source are read
 * again, the rest of the source is left alone. A chunk a view shows stays on
 * screen until its new data replaces it; a chunk that was only read ahead is
 * dropped. Each chunk has its own generation, so that two calls for different
 * chunks do not cancel each other, and two calls for the same chunk leave the
 * newer one's data on screen whatever order the answers come in.
 *
 * The queue manager is built as in `refresh_source_cache.spec.ts`.
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
): FakeChunk {
  return { key, state, priorityTier, priority: 0, gpuMemoryBytes: 100 };
}

/** Reads answer when the test lets them: `release(key, tag)`. */
function makeSource(chunks: FakeChunk[]) {
  const waiting: { key: string; answer: (tag: string) => void }[] = [];
  const source = {
    chunks: new Map(chunks.map((c) => [c.key, c])),
    readFresh: vi.fn(
      (c: FakeChunk) =>
        new Promise<Fresh>((resolve) => {
          waiting.push({
            key: c.key,
            answer: (tag) => resolve({ key: c.key, empty: false, tag }),
          });
        }),
    ),
    isFreshEmpty: (fresh: Fresh) => fresh.empty,
    freshBytes: () => 100,
  };
  /** Answers the oldest read of `key` that is still waiting. */
  const release = async (key: string, tag: string) => {
    await vi.advanceTimersByTimeAsync(0);
    const index = waiting.findIndex((w) => w.key === key);
    if (index < 0) throw new Error(`no read of ${key} is waiting`);
    waiting.splice(index, 1)[0].answer(tag);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { source, release, waiting };
}

function makeQueue() {
  const queue = Object.create(ChunkQueueManager.prototype) as any;
  queue.refreshSlots = new Slots(16);
  queue.chunkGenerations = new WeakMap();
  queue.chunkGeneration = 0;
  queue.evicted = [] as string[];
  queue.sent = [] as string[];
  queue.evictChunk = vi.fn((c: FakeChunk) => {
    queue.evicted.push(c.key);
    c.state = ChunkState.QUEUED;
  });
  queue.sendFreshChunk = vi.fn((c: FakeChunk, fresh: Fresh) => {
    queue.sent.push(`${c.key} <- ${fresh.tag}`);
  });
  return queue as {
    invalidateCachedChunks(
      source: any,
      keys: Iterable<string>,
      signal: AbortSignal,
    ): Promise<{
      refreshed: number;
      skipped: number;
      failed: number;
      dropped: number;
    }>;
    evicted: string[];
    sent: string[];
  };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ChunkQueueManager.invalidateCachedChunks", () => {
  it("reads the named chunks again and touches no other chunk of the source", async () => {
    const queue = makeQueue();
    const { source, release } = makeSource([
      chunk("a"),
      chunk("b"),
      chunk("c"),
    ]);

    const done = queue.invalidateCachedChunks(source, ["a", "b"], signal());
    await release("a", "a2");
    await release("b", "b2");

    expect(await done).toEqual({
      refreshed: 2,
      skipped: 0,
      failed: 0,
      dropped: 0,
    });
    expect(queue.sent).toEqual(["a <- a2", "b <- b2"]);
    expect(queue.evicted).toEqual([]);
    expect(source.readFresh).toHaveBeenCalledTimes(2);
  });

  it("keeps a chunk on screen until its new data is here", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const { source, release } = makeSource([a]);

    const done = queue.invalidateCachedChunks(source, ["a"], signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(a.state).toBe(ChunkState.GPU_MEMORY);
    expect(queue.evicted).toEqual([]);
    expect(queue.sent).toEqual([]);
    await release("a", "a2");
    await done;
    expect(queue.sent).toEqual(["a <- a2"]);
  });

  it("drops a chunk that was only read ahead, and counts it, instead of reading it again", async () => {
    const queue = makeQueue();
    const { source, release } = makeSource([
      chunk("shown"),
      chunk("ahead", ChunkState.GPU_MEMORY, ChunkPriorityTier.PREFETCH),
      chunk("ahead2", ChunkState.GPU_MEMORY, ChunkPriorityTier.PREFETCH),
    ]);

    const done = queue.invalidateCachedChunks(
      source,
      ["shown", "ahead", "ahead2"],
      signal(),
    );
    await release("shown", "new");

    expect(await done).toEqual({
      refreshed: 1,
      skipped: 0,
      failed: 0,
      dropped: 2,
    });
    expect(queue.evicted).toEqual(["ahead", "ahead2"]);
    expect(source.readFresh).toHaveBeenCalledTimes(1);
    expect(queue.sent).toEqual(["shown <- new"]);
  });

  it("drops a chunk that is not on the GPU: downloading, in memory, or no longer asked for", async () => {
    const queue = makeQueue();
    const { source } = makeSource([
      chunk("downloading", ChunkState.DOWNLOADING),
      chunk("memory", ChunkState.SYSTEM_MEMORY),
      chunk("recent", ChunkState.GPU_MEMORY, ChunkPriorityTier.RECENT),
      chunk("queued", ChunkState.QUEUED),
    ]);

    const result = await queue.invalidateCachedChunks(
      source,
      ["downloading", "memory", "recent", "queued", "not-in-the-cache"],
      signal(),
    );

    expect(result).toEqual({ refreshed: 0, skipped: 0, failed: 0, dropped: 4 });
    expect(queue.evicted.sort()).toEqual([
      "downloading",
      "memory",
      "queued",
      "recent",
    ]);
    expect(source.readFresh).not.toHaveBeenCalled();
  });

  it("two strokes in neighbouring chunks, answers in reverse order: both are shown", async () => {
    const queue = makeQueue();
    const { source, release } = makeSource([chunk("left"), chunk("right")]);

    const first = queue.invalidateCachedChunks(source, ["left"], signal());
    const second = queue.invalidateCachedChunks(source, ["right"], signal());
    await release("right", "stroke-2");
    await release("left", "stroke-1");

    expect((await first).refreshed).toBe(1);
    expect((await second).refreshed).toBe(1);
    expect(queue.sent).toEqual(["right <- stroke-2", "left <- stroke-1"]);
    expect(queue.evicted).toEqual([]);
  });

  it("two strokes in the same chunk, answers in reverse order: the second stroke's data stays", async () => {
    const queue = makeQueue();
    const { source, waiting } = makeSource([chunk("a")]);

    const first = queue.invalidateCachedChunks(source, ["a"], signal());
    const second = queue.invalidateCachedChunks(source, ["a"], signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.length).toBe(2);
    // The second read (it has both strokes) answers first, the first one
    // (the first stroke only) after it.
    const [older, newer] = waiting.splice(0, 2);
    newer.answer("both-strokes");
    await vi.advanceTimersByTimeAsync(0);
    older.answer("first-stroke-only");
    await vi.advanceTimersByTimeAsync(0);

    expect(await first).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(await second).toMatchObject({ refreshed: 1 });
    expect(queue.sent).toEqual(["a <- both-strokes"]);
    expect(queue.evicted).toEqual([]);
  });

  it("drops a chunk that left the GPU before its new data came, so that its old data is not shown again", async () => {
    const queue = makeQueue();
    const a = chunk("a");
    const { source, release } = makeSource([a]);

    const done = queue.invalidateCachedChunks(source, ["a"], signal());
    await vi.advanceTimersByTimeAsync(0);
    // The cache moves the chunk off the GPU; the frontend keeps its bytes.
    a.state = ChunkState.SYSTEM_MEMORY;
    await release("a", "new");

    expect(await done).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(queue.sent).toEqual([]);
    expect(queue.evicted).toEqual(["a"]);
  });

  it("drops a chunk whose read fails, and leaves the others", async () => {
    const queue = makeQueue();
    const { source, release } = makeSource([chunk("a"), chunk("b")]);
    source.readFresh.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    const done = queue.invalidateCachedChunks(source, ["a", "b"], signal());
    await release("b", "b2");

    expect(await done).toMatchObject({ refreshed: 1, failed: 1 });
    expect(queue.evicted).toEqual(["a"]);
    expect(queue.sent).toEqual(["b <- b2"]);
  });

  it("drops every named chunk of a source that cannot read a chunk into a spare object", async () => {
    const queue = makeQueue();
    const source = {
      chunks: new Map([
        ["a", chunk("a")],
        ["b", chunk("b")],
      ]),
    };

    const result = await queue.invalidateCachedChunks(source, ["a"], signal());

    expect(result).toEqual({ refreshed: 0, skipped: 0, failed: 0, dropped: 1 });
    expect(queue.evicted).toEqual(["a"]);
  });
});
