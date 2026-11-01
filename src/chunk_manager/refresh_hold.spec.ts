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

import { describe, expect, it, vi } from "vitest";

import { ChunkQueueManager } from "#src/chunk_manager/frontend.js";
import { UpdateHold } from "#src/chunk_manager/soft_refresh.js";
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

  it("applies nothing until the last of two holds ends", () => {
    const { queue, flushed, receive } = setup();
    queue.beginRefreshHold();
    queue.beginRefreshHold();
    receive({ source: 1, id: "swap", refresh: true });

    queue.endRefreshHold();
    expect(flushed[0], "applied by the first hold's end").toEqual([]);
    queue.endRefreshHold();

    expect(flushed[1]).toEqual(["swap"]);
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
