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
 * The frontend side of a soft refresh: while the page holds the replacements
 * the worker sends, the frontend keeps them back, and puts them on screen
 * together when the hold ends. `soft_refresh.spec.ts` covers what is kept;
 * these tests go through the real `Chunk.update` message handler to cover that
 * it asks, and that the kept updates join the queue behind what was already
 * waiting, in the order they arrived, and are applied by one flush.
 *
 * The queue manager is built without a GL context: only the fields these
 * paths read are given. Messages arrive through a real `RPC` on a fake target.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHUNK_SOURCE_REFRESH_RPC_ID,
  ChunkState,
} from "#src/chunk_manager/base.js";
import { ChunkQueueManager, ChunkSource } from "#src/chunk_manager/frontend.js";
import { UpdateHold } from "#src/chunk_manager/soft_refresh.js";
import {
  DraftHider,
  type RefreshReply,
  type ViewerLike,
  handleSoftInvalidate,
} from "#src/custom/layer_reload.js";
import { RPC } from "#src/worker_rpc.js";

function setup() {
  const queue = Object.create(ChunkQueueManager.prototype) as any;
  queue.refreshHold = new UpdateHold();
  queue.pendingChunkUpdates = null;
  queue.pendingChunkUpdatesTail = null;
  queue.scheduleChunkUpdate = vi.fn();
  // what the pending list holds, in order, at the moment of each flush
  const flushed: string[][] = [];
  queue.flushPendingChunkUpdates = vi.fn(() => {
    const ids: string[] = [];
    for (let u = queue.pendingChunkUpdates; u != null; u = u.nextUpdate) {
      ids.push(u.id);
    }
    flushed.push(ids);
    return ids.length;
  });
  const target = { postMessage: vi.fn(), onmessage: null as any };
  const rpc = new RPC(target, false);
  queue.rpc = rpc;
  const source = () => ({
    chunkManager: { chunkQueueManager: queue },
    immediateChunkUpdates: false,
  });
  rpc.set(1, source());
  rpc.set(2, source());
  /** The worker sends a `Chunk.update`. */
  const receive = (update: { source: number; id: string; refresh?: boolean }) =>
    target.onmessage({ data: { functionName: "Chunk.update", ...update } });
  const queued = () => {
    const ids: string[] = [];
    for (let u = queue.pendingChunkUpdates; u != null; u = u.nextUpdate) {
      ids.push(u.id);
    }
    return ids;
  };
  return { queue, rpc, flushed, receive, queued };
}

describe("a soft refresh's replacements in the frontend", () => {
  it("queues a replacement as usual when no hold is active", () => {
    const { receive, queued } = setup();

    receive({ source: 1, id: "swap", refresh: true });

    expect(queued()).toEqual(["swap"]);
  });

  it("keeps a replacement back while a hold is active: the message handler asks", () => {
    const { queue, receive, queued } = setup();
    queue.beginRefreshHold();

    receive({ source: 1, id: "swap", refresh: true });

    expect(queued(), "a held update reached the queue").toEqual([]);
  });

  it("does not hold an update of another source", () => {
    const { queue, receive, queued } = setup();
    queue.beginRefreshHold();
    receive({ source: 1, id: "swap", refresh: true });

    receive({ source: 2, id: "other layer panning in" });

    expect(queued()).toEqual(["other layer panning in"]);
  });

  it("applies the kept updates together, behind what was already waiting, in the order they arrived", () => {
    const { queue, flushed, receive } = setup();
    receive({ source: 1, id: "waiting-before" });
    queue.beginRefreshHold();
    receive({ source: 1, id: "swap-1", refresh: true });
    receive({ source: 2, id: "swap-2", refresh: true });
    receive({ source: 1, id: "evict-after-swap-1" });

    queue.endRefreshHold();

    // one flush, with everything in it
    expect(flushed).toEqual([
      ["waiting-before", "swap-1", "swap-2", "evict-after-swap-1"],
    ]);
  });

  it("applies what was kept at every end, also while another hold is still active", () => {
    // the answer of the first refresh says its replacements are on screen
    const { queue, flushed, receive } = setup();
    queue.beginRefreshHold();
    queue.beginRefreshHold();
    receive({ source: 1, id: "first refresh's swap", refresh: true });

    queue.endRefreshHold();

    expect(
      flushed[0],
      "the kept replacement was held back again by the hold that is still active",
    ).toEqual(["first refresh's swap"]);
  });

  it("keeps what arrives after one end until the end of the hold that is still active", () => {
    const { queue, flushed, receive, queued } = setup();
    queue.beginRefreshHold();
    queue.beginRefreshHold();
    queue.endRefreshHold();
    flushed.length = 0;

    receive({ source: 1, id: "second refresh's swap", refresh: true });
    expect(queued(), "kept for the second refresh").toEqual([]);
    queue.endRefreshHold();

    expect(flushed).toEqual([["second refresh's swap"]]);
  });

  it("queues a replacement that arrives after the hold ended as it comes", () => {
    const { queue, receive, queued } = setup();
    queue.beginRefreshHold();
    queue.endRefreshHold();

    receive({ source: 1, id: "late", refresh: true });

    expect(queued()).toEqual(["late"]);
  });

  it("skips a kept update whose source was removed in the meantime", () => {
    const { queue, rpc, flushed, receive } = setup();
    queue.beginRefreshHold();
    receive({ source: 1, id: "kept", refresh: true });
    receive({ source: 2, id: "gone", refresh: true });
    rpc.delete(2);

    queue.endRefreshHold();

    expect(flushed).toEqual([["kept"]]);
  });
});

describe("two commits whose refreshes overlap, through the real hold and the real handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has the first refresh's replacements on screen when it answers ok, although the second began before it finished", async () => {
    const { queue, rpc, flushed, receive } = setup();
    // what a frontend with this queue manager has put on screen so far
    const onScreen = () => new Set(flushed.flat());
    const gate = {
      a: Promise.withResolvers<void>(),
      b: Promise.withResolvers<void>(),
    };
    const done = {
      refreshed: 1,
      skipped: 0,
      failed: 0,
      fellBack: false,
      superseded: false,
    };
    // each source's refresh: the worker sends its replacement, then answers
    const sourceFor = (rpcId: number, name: string, wait: Promise<void>) => ({
      refreshCache: vi.fn(async () => {
        await wait;
        receive({ source: rpcId, id: name, refresh: true });
        return done;
      }),
      invalidateCache: vi.fn(),
    });
    const sourceA = sourceFor(1, "A's replacement", gate.a.promise);
    const sourceB = sourceFor(2, "B's replacement", gate.b.promise);
    const layerPanel = (name: string, source: object) => {
      const renderLayer = { userLayer: { managedLayer: { name } } };
      return {
        sliceView: {
          visibleLayerList: [renderLayer],
          visibleLayers: new Map([
            [renderLayer, { allSources: [[{ source }]] }],
          ]),
        },
      };
    };
    const viewer = {
      display: {
        panels: new Set([
          layerPanel("layer A", sourceA),
          layerPanel("layer B", sourceB),
        ]),
        scheduleRedraw: vi.fn(),
      },
      layerManager: {
        getLayerByName: () => undefined,
        layersChanged: { add: () => () => {} },
      },
      chunkQueueManager: queue,
    } as unknown as ViewerLike;
    const seen: Record<string, Set<string>> = {};
    const env = (commit: string) => ({
      post: (reply: RefreshReply) => {
        seen[commit] = onScreen();
        void reply;
      },
      frames: async () => {},
      timeoutMs: 8000,
      abortAfterMs: 60_000,
    });
    const hider = new DraftHider(viewer.layerManager);

    const a = handleSoftInvalidate(
      viewer,
      { layerName: "layer A", commitId: "A" },
      env("A"),
      hider,
    );
    await vi.advanceTimersByTimeAsync(10);
    const b = handleSoftInvalidate(
      viewer,
      { layerName: "layer B", commitId: "B" },
      env("B"),
      hider,
    );
    await vi.advanceTimersByTimeAsync(10);
    gate.a.resolve();
    await a;
    gate.b.resolve();
    await b;

    expect(
      seen.A,
      "A answered ok while its replacement was still held back",
    ).toContain("A's replacement");
    expect(seen.B).toContain("B's replacement");
    expect(rpc.numObjects).toBe(2);
  });
});

describe("ChunkSource.refreshCache", () => {
  const result = {
    refreshed: 1,
    skipped: 0,
    failed: 0,
    fellBack: false,
    superseded: false,
  };

  it("asks the worker to refresh this source, and passes the signal so that a cancel reaches the reads", async () => {
    const source = Object.create(ChunkSource.prototype) as any;
    source.rpcId = 9;
    source.rpc = { promiseInvoke: vi.fn(async () => result) };
    const signal = new AbortController().signal;

    const answer = await source.refreshCache(signal);

    expect(answer).toBe(result);
    // `source`, not `id`: promiseInvoke puts its own id in `id`
    expect(source.rpc.promiseInvoke).toHaveBeenCalledWith(
      CHUNK_SOURCE_REFRESH_RPC_ID,
      { source: 9 },
      { signal },
    );
  });

  it("works without a signal", async () => {
    const source = Object.create(ChunkSource.prototype) as any;
    source.rpcId = 9;
    source.rpc = { promiseInvoke: vi.fn(async () => result) };

    await source.refreshCache();

    expect(source.rpc.promiseInvoke).toHaveBeenCalledWith(
      CHUNK_SOURCE_REFRESH_RPC_ID,
      { source: 9 },
      { signal: undefined },
    );
  });
});

describe("a chunk that reaches the frontend for a key it already has", () => {
  function frontendWith(old: { state: ChunkState; freeGPUMemory: () => void }) {
    const { queue, rpc } = setup();
    queue.gl = {};
    const newChunk = {
      state: ChunkState.SYSTEM_MEMORY,
      copyToGPU: vi.fn(function (this: { state: ChunkState }) {
        this.state = ChunkState.GPU_MEMORY;
      }),
    };
    const source = Object.create(ChunkSource.prototype) as any;
    source.chunks = new Map<string, unknown>([["k", old]]);
    source.chunkManager = { chunkQueueManager: queue };
    source.getChunk = vi.fn(() => newChunk);
    rpc.set(3, source);
    return { queue, source, newChunk };
  }

  it("frees the GPU memory of the chunk it replaces, puts the new one on the GPU, and says the visible chunks changed", () => {
    const old = { state: ChunkState.GPU_MEMORY, freeGPUMemory: vi.fn() };
    const { queue, source, newChunk } = frontendWith(old);

    const changed = queue.applyChunkUpdate({
      source: 3,
      id: "k",
      new: true,
      state: ChunkState.GPU_MEMORY,
    });

    expect(old.freeGPUMemory).toHaveBeenCalledTimes(1);
    expect(newChunk.copyToGPU).toHaveBeenCalledTimes(1);
    expect(source.chunks.get("k")).toBe(newChunk);
    expect(changed).toBe(true);
  });

  it("adds a chunk that has no predecessor, as it always did, and frees nothing", () => {
    const old = { state: ChunkState.GPU_MEMORY, freeGPUMemory: vi.fn() };
    const { queue, source, newChunk } = frontendWith(old);

    queue.applyChunkUpdate({
      source: 3,
      id: "another key",
      new: true,
      state: ChunkState.GPU_MEMORY,
    });

    expect(old.freeGPUMemory).not.toHaveBeenCalled();
    expect(source.chunks.get("another key")).toBe(newChunk);
    expect(source.chunks.get("k")).toBe(old);
  });
});
