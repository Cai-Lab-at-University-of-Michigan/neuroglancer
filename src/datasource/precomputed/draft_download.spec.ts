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
 * Where `PrecomputedVolumeChunkSource.download` reads a chunk from: the CDN,
 * or the backend's draft route for a chunk the user's draft may cover (see
 * `draft_route.ts`). The source is built without its RPC and its key-value
 * store is a recorder.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { draftRoutes } from "#src/custom/draft_route.js";
import { PrecomputedVolumeChunkSource } from "#src/datasource/precomputed/backend.js";
import { VolumeChunkEncoding } from "#src/datasource/precomputed/base.js";

const CDN = "http://cdn.test/data/u1/seg";
const BASE = "http://api.test/api/v1/plugins/drafts/layer-1/chunk";

function makeSource(
  level: number,
  chunkDataSize: number[],
  options: { sharded?: boolean; encoding?: VolumeChunkEncoding } = {},
) {
  const source = Object.create(PrecomputedVolumeChunkSource.prototype) as any;
  const cdnReads: string[] = [];
  const shardReads: unknown[] = [];
  Object.assign(source, {
    parameters: {
      url: `${CDN}/${level}/`,
      encoding: options.encoding ?? VolumeChunkEncoding.RAW,
    },
    spec: {
      rank: 3,
      chunkDataSize: Uint32Array.from(chunkDataSize),
      upperVoxelBound: Float32Array.from([600, 500, 300]),
      baseVoxelOffset: Float32Array.from([0, 0, 0]),
    },
    tempChunkDataSize: new Uint32Array(3),
    tempChunkPosition: new Float32Array(3),
    gridShape: Uint32Array.from([8, 8, 8]),
    kvStore: {
      path: `u1/seg/${level}/`,
      store: {
        read: vi.fn(async (path: string) => {
          cdnReads.push(path);
          return undefined;
        }),
      },
    },
    shardedKvStore: options.sharded
      ? {
          read: vi.fn(async (index: unknown) => {
            shardReads.push(index);
            return undefined;
          }),
        }
      : undefined,
    chunkDecoder: vi.fn(async () => {}),
  });
  const download = (grid: number[]) =>
    source.download(
      { chunkGridPosition: Float32Array.from(grid), chunkDataSize: null },
      new AbortController().signal,
    ) as Promise<void>;
  return { source, cdnReads, shardReads, download };
}

/** A fetch that answers every draft chunk, and records what was asked. */
function stubFetch(status = 200) {
  const asked: { url: string; credentials: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      asked.push({ url, credentials: init.credentials });
      return {
        ok: status === 200,
        status,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      };
    }),
  );
  return asked;
}

function touchRegionZero() {
  draftRoutes.apply({
    kind: "state",
    layerItemId: "layer-1",
    location: "u1/seg",
    base: BASE,
    generation: 3,
    regions: [[0, 0, 0]],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  draftRoutes.routes.clear();
});

describe("PrecomputedVolumeChunkSource.download and the draft route", () => {
  it("with no draft message received, every chunk is read from the CDN at the path it always had", async () => {
    const asked = stubFetch();
    const slabs = makeSource(1, [256, 256, 1]);
    const cubes = makeSource(8, [32, 32, 32]);

    await slabs.download([0, 0, 5]);
    await slabs.download([2, 1, 299]);
    await cubes.download([1, 2, 3]);

    expect(slabs.cdnReads).toEqual([
      "u1/seg/1/0-256_0-256_5-6",
      "u1/seg/1/512-600_256-500_299-300",
    ]);
    expect(cubes.cdnReads).toEqual(["u1/seg/8/32-64_64-96_96-128"]);
    expect(asked).toEqual([]);
    expect(slabs.source.chunkDecoder).not.toHaveBeenCalled();
  });

  it("asks the draft route for the chunk's own box: three slab layouts, a cube, and a wide slab at 4x", async () => {
    const asked = stubFetch();
    touchRegionZero();

    const xy = makeSource(1, [256, 256, 1]);
    const xz = makeSource(1, [256, 1, 256]);
    const yz = makeSource(1, [1, 256, 256]);
    const cube = makeSource(2, [32, 32, 32]);
    const wide = makeSource(4, [512, 256, 1]);
    await xy.download([0, 0, 5]);
    await xz.download([0, 7, 0]);
    await yz.download([9, 0, 0]);
    await cube.download([1, 0, 1]);
    await wide.download([0, 0, 31]);

    expect(asked.map((a) => a.url)).toEqual([
      `${BASE}/1/0-256_0-256_5-6?gen=3`,
      `${BASE}/1/0-256_7-8_0-256?gen=3`,
      `${BASE}/1/9-10_0-256_0-256?gen=3`,
      `${BASE}/2/32-64_0-32_32-64?gen=3`,
      `${BASE}/4/0-512_0-256_31-32?gen=3`,
    ]);
    expect(asked.every((a) => a.credentials === "include")).toBe(true);
    for (const s of [xy, xz, yz, cube, wide]) {
      expect(s.cdnReads).toEqual([]);
      expect(s.source.chunkDecoder).toHaveBeenCalledTimes(1);
    }
  });

  it("clips the box the draft route is asked for at the volume's edge, as the CDN path is", async () => {
    const asked = stubFetch();
    draftRoutes.apply({
      kind: "state",
      layerItemId: "layer-1",
      location: "u1/seg",
      base: BASE,
      generation: 3,
      regions: [[2, 3, 4]], // x 512.., y 384.., z 256..
    });
    const slabs = makeSource(1, [256, 256, 1]);

    await slabs.download([2, 1, 299]);

    expect(asked.map((a) => a.url)).toEqual([
      `${BASE}/1/512-600_256-500_299-300?gen=3`,
    ]);
  });

  it("reads a chunk the draft does not cover from the CDN, with no request to the route", async () => {
    const asked = stubFetch();
    touchRegionZero();
    const slabs = makeSource(1, [256, 256, 1]);

    await slabs.download([0, 0, 128]);
    await slabs.download([1, 0, 0]);

    expect(slabs.cdnReads).toEqual([
      "u1/seg/1/0-256_0-256_128-129",
      "u1/seg/1/256-512_0-256_0-1",
    ]);
    expect(asked).toEqual([]);
  });

  it("reads a refused chunk from the CDN at its own path, even when other chunks were placed meanwhile", async () => {
    stubFetch(401);
    touchRegionZero();
    const slabs = makeSource(1, [256, 256, 1]);

    // Both are in flight together: the second call reuses the source's
    // scratch position before the first one's refusal comes back.
    await Promise.all([slabs.download([0, 0, 5]), slabs.download([0, 1, 9])]);

    expect(slabs.cdnReads.sort()).toEqual([
      "u1/seg/1/0-256_0-256_5-6",
      "u1/seg/1/0-256_256-500_9-10",
    ]);
    expect(slabs.source.chunkDecoder).not.toHaveBeenCalled();
  });

  it("never sends a sharded source or a source that is not raw to the draft route", async () => {
    const asked = stubFetch();
    touchRegionZero();
    const sharded = makeSource(1, [64, 64, 64], { sharded: true });
    const compressed = makeSource(1, [64, 64, 64], {
      encoding: VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
    });

    await sharded.download([0, 0, 0]);
    await compressed.download([0, 0, 0]);

    expect(asked).toEqual([]);
    expect(sharded.shardReads.length).toBe(1);
    expect(compressed.cdnReads).toEqual(["u1/seg/1/0-64_0-64_0-64"]);
  });
});
