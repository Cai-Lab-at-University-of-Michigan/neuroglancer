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
 * Which chunks `SliceViewBackend.updateVisibleChunks` asks for ahead of time
 * when a layer has a draft (see `draft_route.ts`): a chunk the draft route
 * would compute at a level coarser than 4x is asked for only once a view
 * shows it.
 *
 * The slice view is built without its RPC. The geometry (which chunks the
 * view plane cuts) is replaced by one chunk at a fixed grid position; the
 * loop that walks from it to its neighbours is the real one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import { draftRoutes } from "#src/custom/draft_route.js";
import { SliceViewBackend } from "#src/sliceview/backend.js";
import type * as Base from "#src/sliceview/base.js";

vi.mock("#src/sliceview/base.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Base>()),
  getNormalizedChunkLayout: (_parameters: unknown, layout: unknown) => layout,
  // The view plane cuts exactly one chunk: the one at the source's `seen`.
  forEachPlaneIntersectingVolumetricChunk: (
    _parameters: unknown,
    _localPosition: unknown,
    tsource: { seen: number[]; curPositionInChunks: Float32Array },
    _layout: unknown,
    callback: (position: Float32Array) => void,
  ) => {
    tsource.curPositionInChunks.set(tsource.seen);
    callback(tsource.curPositionInChunks);
  },
}));

const CDN = "http://cdn.test/data/u1/seg";

/**
 * A slice view over one source of z slabs at `level`, looking at the slab at
 * grid position `seen`, with the view moving along z fast enough that the
 * neighbouring slabs are wanted ahead of time. Returns what was asked for.
 */
function wanted(level: number, seen: number[], prefetch = true) {
  const requests: { z: number; tier: ChunkPriorityTier }[] = [];
  const chunks = new Map<string, { chunkGridPosition: Float32Array }>();
  const tsource = {
    seen,
    curPositionInChunks: Float32Array.from(seen),
    chunkLayout: {
      size: Float32Array.of(256, 256, 1),
      finiteRank: 3,
      globalToLocalSpatial: (out: Float32Array, position: Float32Array) =>
        out.set(position),
    },
    renderLayer: { localPosition: { value: new Float32Array(0) } },
    // Identity: global x, y, z are the chunk's x, y, z.
    combinedGlobalLocalToChunkTransform: Float32Array.of(
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
    ),
    layerRank: 3,
    chunkDisplayDimensionIndices: [0, 1],
    fixedPositionWithinChunk: Float32Array.of(0, 0, 0),
    lowerClipBound: Float32Array.of(0, 0, 0),
    upperClipBound: Float32Array.of(256, 256, 64),
    source: {
      parameters: { url: `${CDN}/${level}/` },
      spec: {
        rank: 3,
        chunkDataSize: Uint32Array.of(256, 256, 1),
        baseVoxelOffset: Float32Array.of(0, 0, 0),
      },
      getChunk(position: Float32Array) {
        const key = Array.from(position).join();
        let chunk = chunks.get(key);
        if (chunk === undefined) {
          chunk = { chunkGridPosition: Float32Array.from(position) };
          chunks.set(key, chunk);
        }
        return chunk;
      },
    },
  };
  const layer = {};
  const view = Object.create(SliceViewBackend.prototype) as any;
  Object.assign(view, {
    projectionParameters: {
      value: {
        centerDataPosition: Float32Array.of(0, 0, seen[2]),
        globalPosition: Float32Array.of(0, 0, seen[2]),
      },
    },
    visibility: { value: Number.POSITIVE_INFINITY },
    updateVisibleSources: () => {},
    visibleLayers: new Map([[layer, { visibleSources: [tsource] }]]),
    // The view has been moving along z: no drift, a spread of 0.002 voxels
    // per millisecond.
    velocityEstimator: {
      addSample: () => {},
      rank: 3,
      mean: Float32Array.of(0, 0, 0),
      variance: Float32Array.of(0, 0, 4e-6),
    },
    chunkManager: {
      registerLayer: () => {},
      queueManager: { enablePrefetch: { value: prefetch } },
      requestChunk: (
        chunk: { chunkGridPosition: Float32Array },
        tier: ChunkPriorityTier,
      ) => requests.push({ z: chunk.chunkGridPosition[2], tier }),
    },
  });
  view.updateVisibleChunks();
  const ahead = requests
    .filter((r) => r.tier === ChunkPriorityTier.PREFETCH)
    .map((r) => r.z)
    .sort((a, b) => a - b);
  const shown = requests
    .filter((r) => r.tier === ChunkPriorityTier.VISIBLE)
    .map((r) => r.z);
  return { ahead, shown };
}

/** The draft holds something in the 128^3 region at 0, 0, 0: z 0..16 at 8x. */
function touch() {
  draftRoutes.apply({
    kind: "state",
    layerItemId: "layer-1",
    location: "u1/seg",
    base: "http://api.test/api/v1/plugins/drafts/layer-1/chunk",
    generation: 1,
    regions: [[0, 0, 0]],
  });
}

afterEach(() => {
  draftRoutes.routes.clear();
});

describe("SliceViewBackend.updateVisibleChunks and a draft", () => {
  it("with no draft, asks for the slabs next to the one on screen ahead of time", () => {
    const { ahead, shown } = wanted(8, [0, 0, 8]);
    expect(shown).toEqual([8]);
    expect(ahead).toContain(7);
    expect(ahead).toContain(9);
    expect(ahead.length).toBeGreaterThanOrEqual(4);
  });

  it("asks for no slab the draft covers ahead of time at 8x and 16x, and still for the one on screen", () => {
    const before = wanted(8, [0, 0, 8]).ahead;
    touch();
    const at8 = wanted(8, [0, 0, 8]);
    expect(at8.shown).toEqual([8]);
    // z 0..15 at 8x is the touched region; what lies beyond is the CDN's.
    expect(before.some((z) => z < 16)).toBe(true);
    expect(at8.ahead).toEqual(before.filter((z) => z >= 16));
    const at16 = wanted(16, [0, 0, 6]);
    expect(at16.shown).toEqual([6]);
    expect(at16.ahead.some((z) => z < 8)).toBe(false);
    expect(at16.ahead).toContain(8);
  });

  it("asks ahead of time as before at 4x and finer, and outside the draft at 8x", () => {
    const fine = wanted(4, [0, 0, 8]).ahead;
    const far = wanted(8, [0, 0, 40]).ahead;
    touch();
    expect(wanted(4, [0, 0, 8]).ahead).toEqual(fine);
    expect(wanted(8, [0, 0, 40]).ahead).toEqual(far);
    expect(fine).toContain(7);
    expect(far).toContain(39);
  });
});
