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
 * `VolumeChunkSource.readFresh`: the read a soft refresh makes. It uses the
 * source's own `download` on a spare chunk object, so the chunk in the cache
 * keeps serving, with its state, its size and its place in the queues, until
 * the caller replaces it.
 */

import { describe, expect, it, vi } from "vitest";

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { vec3 } from "#src/util/geom.js";

function setup(
  download: (chunk: VolumeChunk, signal: AbortSignal) => Promise<void>,
) {
  const source = Object.create(
    VolumeChunkSource.prototype,
  ) as VolumeChunkSource;
  const chunkStateChanged = vi.fn();
  Object.assign(source, { download, chunkStateChanged });
  const cached = new VolumeChunk();
  cached.source = source;
  cached.initializeVolumeChunk("1,2,3", Float32Array.from([1, 2, 3]) as vec3);
  cached.state = ChunkState.GPU_MEMORY;
  chunkStateChanged.mockClear();
  source.chunks = new Map([["1,2,3", cached]]);
  return { source, cached, chunkStateChanged };
}

describe("VolumeChunkSource.readFresh", () => {
  it("reads the chunk again into a new object that has the same key and grid position and is not in the cache", async () => {
    const download = vi.fn(async (chunk: VolumeChunk) => {
      chunk.data = new Uint8Array(16);
    });
    const { source, cached } = setup(download);
    const signal = new AbortController().signal;

    const fresh = await source.readFresh(cached, signal);

    expect(fresh).not.toBe(cached);
    expect(fresh.key).toBe("1,2,3");
    expect(Array.from(fresh.chunkGridPosition)).toEqual([1, 2, 3]);
    expect(fresh.source).toBe(source);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(fresh, signal);
    expect(source.chunks.size).toBe(1);
    expect(source.chunks.get("1,2,3")).toBe(cached);
  });

  it("leaves the cached chunk as it was: state, data and listeners", async () => {
    const { source, cached, chunkStateChanged } = setup(async (chunk) => {
      chunk.data = new Uint8Array(16);
    });
    cached.data = new Uint8Array(4);

    await source.readFresh(cached, new AbortController().signal);

    expect(cached.state).toBe(ChunkState.GPU_MEMORY);
    expect(cached.data).toEqual(new Uint8Array(4));
    expect(chunkStateChanged).not.toHaveBeenCalled();
  });

  it("measures what was read: bytes for data, empty for a chunk that was never written", async () => {
    const written = setup(async (chunk) => {
      chunk.data = new Uint8Array(16);
    });
    const unwritten = setup(async () => {});

    const withData = await written.source.readFresh(
      written.cached,
      new AbortController().signal,
    );
    const without = await unwritten.source.readFresh(
      unwritten.cached,
      new AbortController().signal,
    );

    expect(written.source.isFreshEmpty(withData)).toBe(false);
    expect(written.source.freshBytes(withData)).toBe(16);
    expect(unwritten.source.isFreshEmpty(without)).toBe(true);
    expect(unwritten.source.freshBytes(without)).toBe(0);
  });

  it("passes a failed read on, and leaves the cached chunk alone", async () => {
    const { source, cached } = setup(async () => {
      throw new Error("network");
    });

    await expect(
      source.readFresh(cached, new AbortController().signal),
    ).rejects.toThrow("network");

    expect(source.chunks.get("1,2,3")).toBe(cached);
    expect(cached.state).toBe(ChunkState.GPU_MEMORY);
  });
});
