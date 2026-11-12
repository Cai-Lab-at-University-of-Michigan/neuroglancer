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
 * The draft route as the chunk worker keeps it: which chunks of a layer are
 * read from the backend's draft route, what the three page messages do to
 * that, and what the worker tells the page about an answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DraftNotice,
  DraftUpdateResult,
} from "#src/custom/draft_route.js";
import {
  applyDraftMessage,
  draftMessage,
  DraftRoutes,
  draftSkipsPrefetch,
  handleDraftWindowMessage,
  draftRoutes,
  meets,
  noticeForPage,
  parseScaleUrl,
} from "#src/custom/draft_route.js";

const CDN = "http://cdn.test/data/u1/seg";
const BASE = "http://api.test/api/v1/plugins/drafts/layer-1/chunk";
const LAYER = { layerItemId: "layer-1", location: "u1/seg", base: BASE };

function setup() {
  const notices: DraftNotice[] = [];
  const routes = new DraftRoutes();
  routes.notify = (notice) => notices.push(notice);
  return { routes, notices };
}

/** The draft holds something in the 128^3 region at z, y, x = 0, 0, 0. */
function withState(routes: DraftRoutes, generation = 5, regions = [[0, 0, 0]]) {
  return routes.apply({ kind: "state", ...LAYER, generation, regions });
}

function answer(status: number, generation?: number) {
  // The part of a Response that a read uses.
  return {
    ok: status === 200,
    status,
    headers: {
      get: (name: string) =>
        name === "X-Draft-Generation" && generation !== undefined
          ? String(generation)
          : null,
    },
    arrayBuffer: async () => new ArrayBuffer(4),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  draftRoutes.routes.clear();
});

describe("parseScaleUrl", () => {
  it("splits a scale's URL into the layer and the level", () => {
    expect(parseScaleUrl(`${CDN}/8/`)).toEqual({ layer: CDN, level: 8 });
    expect(parseScaleUrl(`${CDN}/16`)).toEqual({ layer: CDN, level: 16 });
  });

  it("knows no level for a URL that does not end in one", () => {
    expect(parseScaleUrl(`${CDN}/mesh/`)).toBeUndefined();
    expect(parseScaleUrl(undefined)).toBeUndefined();
  });
});

describe("meets", () => {
  const cells = { cell: 32, keys: new Set([DraftRoutes.key(1, 2, 3)]) };
  // The cell covers x 96..128, y 64..96, z 32..64.

  it("is true for a box that shares a voxel with a cell", () => {
    expect(meets(cells, [0, 0, 63], [256, 256, 1])).toBe(true);
    expect(meets(cells, [127, 95, 32], [1, 1, 1])).toBe(true);
  });

  it("is false for a box that only touches a cell's face", () => {
    expect(meets(cells, [0, 0, 64], [256, 256, 1])).toBe(false);
    expect(meets(cells, [0, 0, 31], [256, 256, 1])).toBe(false);
    expect(meets(cells, [128, 64, 32], [32, 32, 32])).toBe(false);
  });

  it("gives the same answer when the box holds more cells than the set", () => {
    const one = { cell: 8, keys: new Set([DraftRoutes.key(0, 300, 5)]) };
    expect(meets(one, [0, 0, 0], [4096, 4096, 1])).toBe(true);
    expect(meets(one, [0, 0, 8], [4096, 4096, 1])).toBe(false);
  });
});

describe("route choice", () => {
  it("reads every chunk from the CDN while the page has sent no draft state", () => {
    const { routes } = setup();
    for (const level of [1, 2, 4, 8, 16]) {
      expect(
        routes.request(`${CDN}/${level}/`, [0, 0, 0], [256, 256, 1]),
      ).toBeUndefined();
    }
  });

  it("reads a chunk that meets a touched region from the draft route, and no other chunk", () => {
    const { routes } = setup();
    withState(routes);
    expect(routes.request(`${CDN}/1/`, [0, 0, 127], [256, 256, 1])?.url).toBe(
      `${BASE}/1/0-256_0-256_127-128?gen=5`,
    );
    expect(
      routes.request(`${CDN}/1/`, [0, 0, 128], [256, 256, 1]),
    ).toBeUndefined();
    expect(
      routes.request(`${CDN}/1/`, [256, 0, 0], [256, 256, 1]),
    ).toBeUndefined();
    // Another layer on the same CDN.
    expect(
      routes.request(
        "http://cdn.test/data/u1/other/1/",
        [0, 0, 0],
        [32, 32, 32],
      ),
    ).toBeUndefined();
  });

  it("asks for exactly the chunk's own box, whatever the chunk's shape", () => {
    const { routes } = setup();
    withState(routes);
    const url = (level: number, pos: number[], size: number[]) =>
      routes.request(`${CDN}/${level}/`, pos, size)?.url;
    // The three slab layouts, a cube, and a chunk cut short by the volume's edge.
    expect(url(1, [0, 0, 5], [256, 256, 1])).toBe(
      `${BASE}/1/0-256_0-256_5-6?gen=5`,
    );
    expect(url(1, [0, 7, 0], [256, 1, 256])).toBe(
      `${BASE}/1/0-256_7-8_0-256?gen=5`,
    );
    expect(url(1, [9, 0, 0], [1, 256, 256])).toBe(
      `${BASE}/1/9-10_0-256_0-256?gen=5`,
    );
    expect(url(2, [32, 0, 32], [32, 32, 32])).toBe(
      `${BASE}/2/32-64_0-32_32-64?gen=5`,
    );
    expect(url(8, [0, 0, 15], [151, 141, 1])).toBe(
      `${BASE}/8/0-151_0-141_15-16?gen=5`,
    );
  });

  it("sees a region at every level: 128 voxels at 1x are 8 at 16x", () => {
    const { routes } = setup();
    withState(routes, 5, [[1, 0, 0]]); // z 128..256 at 1x
    expect(
      routes.request(`${CDN}/16/`, [0, 0, 7], [64, 64, 1]),
    ).toBeUndefined();
    expect(routes.request(`${CDN}/16/`, [0, 0, 8], [64, 64, 1])).toBeDefined();
    expect(routes.request(`${CDN}/16/`, [0, 0, 15], [64, 64, 1])).toBeDefined();
    expect(
      routes.request(`${CDN}/16/`, [0, 0, 16], [64, 64, 1]),
    ).toBeUndefined();
    expect(
      routes.request(`${CDN}/16/`, [8, 0, 8], [64, 64, 1]),
    ).toBeUndefined();
  });

  it("matches the layer by the end of its URL, or by the whole URL", () => {
    const { routes } = setup();
    routes.apply({
      kind: "state",
      layerItemId: "layer-1",
      base: BASE,
      location: `${CDN}/`,
      generation: 1,
      regions: [[0, 0, 0]],
    });
    expect(routes.request(`${CDN}/1/`, [0, 0, 0], [32, 32, 32])).toBeDefined();
    expect(
      routes.request(
        "http://cdn.test/data/u1/xseg/1/",
        [0, 0, 0],
        [32, 32, 32],
      ),
    ).toBeUndefined();
  });
});

describe("draft_state", () => {
  it("replaces the touched regions and says what to read again: the old and the new ones, at every level", () => {
    const { routes } = setup();
    withState(routes, 5, [[0, 0, 0]]);
    const applied = withState(routes, 6, [[0, 0, 1]]);
    expect(applied.ignored).toBe(false);
    expect(applied.gap).toBe(false);
    expect([...applied.refresh.keys()]).toEqual([1, 2, 4, 8, 16]);
    const at8 = applied.refresh.get(8)!;
    expect(at8.cell).toBe(16);
    expect(meets(at8, [0, 0, 0], [16, 16, 1])).toBe(true); // the old region
    expect(meets(at8, [16, 0, 0], [16, 16, 1])).toBe(true); // the new one
    expect(meets(at8, [32, 0, 0], [16, 16, 1])).toBe(false);
    expect(
      routes.request(`${CDN}/1/`, [0, 0, 0], [32, 32, 32]),
    ).toBeUndefined();
    expect(
      routes.request(`${CDN}/1/`, [128, 0, 0], [32, 32, 32]),
    ).toBeDefined();
  });

  it("does nothing when it is the state the viewer already has", () => {
    const { routes } = setup();
    withState(routes, 5, [
      [0, 0, 0],
      [0, 0, 1],
    ]);
    const again = withState(routes, 5, [
      [0, 0, 1],
      [0, 0, 0],
    ]);
    expect(again).toMatchObject({ ignored: true, gap: false, older: false });
    expect(again.refresh.size).toBe(0);
    // The same generation with other regions is not that state: it is applied.
    const other = withState(routes, 5, [[0, 0, 0]]);
    expect(other.ignored).toBe(false);
    expect(other.refresh.size).toBe(5);
  });

  it("leaves an older state alone and asks again, so the newest stroke stays on the draft route", () => {
    const { routes } = setup();
    withState(routes, 1, [[0, 0, 0]]);
    // A stroke in a region the draft had not touched: x 128..160.
    routes.apply({
      kind: "changed",
      ...LAYER,
      generation: 2,
      prev: 1,
      changed: { "1": [[0, 0, 4]] },
    });
    // The state read before that stroke arrives after it.
    const late = withState(routes, 1, [[0, 0, 0]]);
    expect(late).toMatchObject({ ignored: true, older: true, have: 2 });
    expect(late.refresh.size).toBe(0);
    expect(routes.routes.get("u1/seg")!.generation).toBe(2);
    expect(routes.request(`${CDN}/1/`, [128, 0, 0], [32, 32, 32])?.url).toBe(
      `${BASE}/1/128-160_0-32_0-32?gen=2`,
    );
  });

  it("believes an older state the second time: a backend that restarted counts from the start again", () => {
    const { routes } = setup();
    withState(routes, 40);
    expect(withState(routes, 0, [])).toMatchObject({
      ignored: true,
      older: true,
    });
    const second = withState(routes, 0, []);
    expect(second).toMatchObject({ ignored: false, older: false });
    expect(routes.routes.get("u1/seg")!.generation).toBe(0);
    expect(
      routes.request(`${CDN}/1/`, [0, 0, 0], [32, 32, 32]),
    ).toBeUndefined();
    // Strokes of the new count are applied again.
    const stroke = routes.apply({
      kind: "changed",
      ...LAYER,
      generation: 1,
      prev: 0,
      changed: { "1": [[0, 0, 0]] },
    });
    expect(stroke).toMatchObject({ ignored: false, gap: false });
  });

  it("starts over after a state that is not older: the next older one is left alone again", () => {
    const { routes } = setup();
    withState(routes, 5);
    expect(withState(routes, 3).older).toBe(true);
    expect(withState(routes, 5).ignored).toBe(true);
    expect(withState(routes, 3)).toMatchObject({ ignored: true, older: true });
  });

  it("starts over after a newer state was applied: a late one after it is left alone, not believed", () => {
    const { routes } = setup();
    withState(routes, 5);
    // A late state, the viewer asks, and the answer is newer than what it has.
    expect(withState(routes, 3).older).toBe(true);
    expect(withState(routes, 7, [[0, 0, 1]])).toMatchObject({
      ignored: false,
      older: false,
    });
    // Another late state: it is the first older one again.
    const late = withState(routes, 6, [[0, 0, 0]]);
    expect(late).toMatchObject({ ignored: true, older: true, have: 7 });
    expect(routes.routes.get("u1/seg")!.generation).toBe(7);
    expect(
      routes.request(`${CDN}/1/`, [128, 0, 0], [32, 32, 32]),
    ).toBeDefined();
    expect(
      routes.request(`${CDN}/1/`, [0, 0, 0], [32, 32, 32]),
    ).toBeUndefined();
  });
});

describe("draft_changed", () => {
  const changed = (generation: number, prev: number, keys = [[0, 0, 4]]) => ({
    kind: "changed" as const,
    ...LAYER,
    generation,
    prev,
    changed: {
      "1": keys,
      "2": keys.map((k) => k.map((v) => Math.floor(v / 2))),
      "4": keys.map((k) => k.map((v) => Math.floor(v / 4))),
      "8": keys.map((k) => k.map((v) => Math.floor(v / 8))),
      "16": keys.map((k) => k.map((v) => Math.floor(v / 16))),
    },
  });

  it("adds the region of each changed level-1 key and reads again only what meets a changed key", () => {
    const { routes } = setup();
    withState(routes);
    const applied = routes.apply(changed(6, 5));
    expect(applied).toMatchObject({ ignored: false, gap: false });
    // The key 0, 0, 4 is x 128..160: the region 0, 0, 1.
    expect(routes.request(`${CDN}/1/`, [200, 0, 0], [32, 32, 32])?.url).toBe(
      `${BASE}/1/200-232_0-32_0-32?gen=6`,
    );
    const at1 = applied.refresh.get(1)!;
    expect(at1.cell).toBe(32);
    expect(meets(at1, [128, 0, 0], [32, 32, 32])).toBe(true);
    expect(meets(at1, [160, 0, 0], [32, 32, 32])).toBe(false);
    expect(meets(applied.refresh.get(16)!, [0, 0, 0], [32, 32, 1])).toBe(true);
    expect(meets(applied.refresh.get(16)!, [32, 0, 0], [32, 32, 1])).toBe(
      false,
    );
  });

  it("ignores an old copy or a duplicate", () => {
    const { routes } = setup();
    withState(routes);
    routes.apply(changed(6, 5));
    for (const again of [changed(6, 5), changed(5, 4)]) {
      const applied = routes.apply(again);
      expect(applied.ignored).toBe(true);
      expect(applied.gap).toBe(false);
      expect(applied.refresh.size).toBe(0);
    }
    expect(routes.routes.get("u1/seg")!.generation).toBe(6);
  });

  it("reports a gap when the change does not follow what the viewer has, and still applies it", () => {
    const { routes } = setup();
    withState(routes);
    const applied = routes.apply(changed(8, 7));
    expect(applied).toMatchObject({ ignored: false, gap: true, have: 5 });
    expect(applied.refresh.size).toBe(5);
    expect(routes.routes.get("u1/seg")!.generation).toBe(8);
  });

  it("reports a gap for a change that arrives before any state", () => {
    const { routes } = setup();
    const applied = routes.apply(changed(3, 2));
    expect(applied).toMatchObject({ ignored: false, gap: true });
    expect(
      routes.request(`${CDN}/1/`, [128, 0, 0], [32, 32, 32]),
    ).toBeDefined();
  });
});

describe("draft_released", () => {
  it("sends the released regions back to the CDN and reads nothing", () => {
    const { routes } = setup();
    withState(routes, 5, [
      [0, 0, 0],
      [0, 0, 1],
    ]);
    const applied = routes.apply({
      kind: "released",
      ...LAYER,
      generation: 6,
      prev: 5,
      regions: [[0, 0, 0]],
    });
    expect(applied).toMatchObject({ ignored: false, gap: false });
    expect(applied.refresh.size).toBe(0);
    expect(
      routes.request(`${CDN}/1/`, [0, 0, 0], [32, 32, 32]),
    ).toBeUndefined();
    // A region that still holds a stroke drawn during the Save is not in the
    // list, and stays on the draft route.
    expect(routes.request(`${CDN}/1/`, [128, 0, 0], [32, 32, 32])?.url).toBe(
      `${BASE}/1/128-160_0-32_0-32?gen=6`,
    );
  });
});

describe("reading a draft chunk", () => {
  it("answers nothing for a chunk the CDN serves, without a request", async () => {
    const { routes } = setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    withState(routes);
    const signal = new AbortController().signal;
    expect(
      await routes.read(`${CDN}/1/`, [512, 0, 0], [32, 32, 32], signal),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the user's cookie with the request and hands back the bytes", async () => {
    const { routes, notices } = setup();
    const fetch = vi.fn(async () => answer(200, 5));
    vi.stubGlobal("fetch", fetch);
    withState(routes);
    const signal = new AbortController().signal;
    const data = await routes.read(
      `${CDN}/1/`,
      [0, 0, 0],
      [32, 32, 32],
      signal,
    );
    expect(data?.byteLength).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${BASE}/1/0-32_0-32_0-32?gen=5`, {
      signal,
      credentials: "include",
    });
    expect(notices).toEqual([]);
  });

  for (const status of [401, 403, 404, 409]) {
    it(`reads a chunk the route refused with ${status} from the CDN, tells the page once, and does not ask for the state`, async () => {
      const { routes, notices } = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer(status)),
      );
      withState(routes);
      const signal = new AbortController().signal;
      for (const z of [0, 32, 64]) {
        expect(
          await routes.read(`${CDN}/1/`, [0, 0, z], [32, 32, 32], signal),
        ).toBeUndefined();
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(notices).toEqual([
        {
          kind: "refused",
          layerItemId: "layer-1",
          location: "u1/seg",
          status,
        },
      ]);
    });
  }

  it("tells the page again about a refusal after a new draft state", async () => {
    const { routes, notices } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(401)),
    );
    const signal = new AbortController().signal;
    withState(routes);
    await routes.read(`${CDN}/1/`, [0, 0, 0], [32, 32, 32], signal);
    withState(routes, 6);
    await routes.read(`${CDN}/1/`, [0, 0, 0], [32, 32, 32], signal);
    expect(notices.map((n) => n.kind)).toEqual(["refused", "refused"]);
  });

  it("reads again after a 503, as a read of the CDN does, and hands back the data", async () => {
    const { routes, notices } = setup();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValueOnce(answer(200, 5));
    vi.stubGlobal("fetch", fetch);
    withState(routes);
    const reading = routes.read(
      `${CDN}/1/`,
      [0, 0, 0],
      [32, 32, 32],
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await reading)?.byteLength).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([]);
  });

  it("reads again after a network error, and hands back the data", async () => {
    const { routes } = setup();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(answer(200, 5));
    vi.stubGlobal("fetch", fetch);
    withState(routes);
    const reading = routes.read(
      `${CDN}/1/`,
      [0, 0, 0],
      [32, 32, 32],
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await reading)?.byteLength).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails the read on an answer that is neither data nor a refusal", async () => {
    const { routes, notices } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(500)),
    );
    withState(routes);
    await expect(
      routes.read(
        `${CDN}/1/`,
        [0, 0, 0],
        [32, 32, 32],
        new AbortController().signal,
      ),
    ).rejects.toThrow("500");
    expect(notices).toEqual([]);
  });
});

describe("the answer's generation", () => {
  const read = (routes: DraftRoutes) =>
    routes.read(
      `${CDN}/1/`,
      [0, 0, 0],
      [32, 32, 32],
      new AbortController().signal,
    );
  const stroke = (generation: number) => ({
    kind: "changed" as const,
    ...LAYER,
    generation,
    prev: generation - 1,
    changed: { "1": [[0, 0, 0]] },
  });

  it("asks for nothing while each message arrives within a second of the answers that ran ahead of it", async () => {
    const { routes, notices } = setup();
    withState(routes, 0);
    // Ten strokes. After each write the reads of four panels already carry
    // the new generation, and the message follows 200 ms later.
    for (let generation = 1; generation <= 10; ++generation) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer(200, generation)),
      );
      for (let panel = 0; panel < 4; ++panel) await read(routes);
      await vi.advanceTimersByTimeAsync(200);
      routes.apply(stroke(generation));
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(notices).toEqual([]);
  });

  it("asks for the state once when the message is still missing a second after the answer", async () => {
    const { routes, notices } = setup();
    withState(routes, 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, 1)),
    );
    for (let panel = 0; panel < 4; ++panel) await read(routes);
    await vi.advanceTimersByTimeAsync(999);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(notices).toEqual([
      { kind: "behind", layerItemId: "layer-1", location: "u1/seg", have: 0 },
    ]);
    // The message held for 1.5 s arrives: nothing more is asked.
    await vi.advanceTimersByTimeAsync(500);
    routes.apply(stroke(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(notices.length).toBe(1);
  });

  it("waits for the newest generation seen, not the first", async () => {
    const { routes, notices } = setup();
    withState(routes, 0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, 1)),
    );
    await read(routes);
    await vi.advanceTimersByTimeAsync(500);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, 2)),
    );
    await read(routes);
    routes.apply(stroke(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(notices).toEqual([
      { kind: "behind", layerItemId: "layer-1", location: "u1/seg", have: 1 },
    ]);
  });

  it("is quiet about an answer that is not ahead", async () => {
    const { routes, notices } = setup();
    withState(routes, 7);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, 7)),
    );
    await read(routes);
    await vi.advanceTimersByTimeAsync(5000);
    expect(notices).toEqual([]);
  });
});

describe("prefetch", () => {
  const source = (level: number, chunkDataSize = [256, 256, 1]) => ({
    parameters: { url: `${CDN}/${level}/` },
    spec: { chunkDataSize, baseVoxelOffset: [0, 0, 0] },
  });

  it("is as before while no layer has a draft", () => {
    for (const level of [1, 2, 4, 8, 16]) {
      expect(draftSkipsPrefetch(source(level), [0, 0, 0])).toBe(false);
    }
  });

  it("is skipped for a chunk the draft route would compute coarser than 4x", () => {
    draftRoutes.apply({
      kind: "state",
      ...LAYER,
      generation: 1,
      regions: [[0, 0, 0]],
    });
    expect(draftSkipsPrefetch(source(8), [0, 0, 15])).toBe(true);
    expect(draftSkipsPrefetch(source(16), [0, 0, 7])).toBe(true);
  });

  it("is kept at 1x, 2x and 4x, and for the chunks the CDN serves at any level", () => {
    draftRoutes.apply({
      kind: "state",
      ...LAYER,
      generation: 1,
      regions: [[0, 0, 0]],
    });
    for (const level of [1, 2, 4]) {
      expect(draftSkipsPrefetch(source(level), [0, 0, 0])).toBe(false);
    }
    expect(draftSkipsPrefetch(source(8), [0, 0, 16])).toBe(false);
    expect(draftSkipsPrefetch(source(16), [1, 0, 0])).toBe(false);
    expect(draftSkipsPrefetch({ spec: source(8).spec }, [0, 0, 0])).toBe(false);
  });
});

describe("applyDraftMessage", () => {
  type FakeChunk = { key: string; grid: number[]; chunkDataSize?: number[] };

  /** A source of the layer at `level` whose chunks have `shape`, holding the chunks at `grids`. */
  function source(
    level: number,
    shape: number[],
    grids: number[][],
    layer = CDN,
  ) {
    const chunks = new Map<string, FakeChunk>();
    for (const grid of grids) {
      const key = grid.join();
      chunks.set(key, { key, grid });
    }
    return {
      name: `${level}x ${shape.join("x")}`,
      parameters: { url: `${layer}/${level}/` },
      chunks,
      computeChunkBounds(chunk: FakeChunk) {
        chunk.chunkDataSize = shape;
        return chunk.grid.map((g, i) => g * shape[i]);
      },
    };
  }

  function queueOf(sources: ReturnType<typeof source>[]) {
    const invalidated = new Map<string, string[]>();
    return {
      invalidated,
      sources: new Set<unknown>(sources),
      invalidateCachedChunks: vi.fn(
        async (s: ReturnType<typeof source>, keys: Iterable<string>) => {
          invalidated.set(s.name, [...keys].sort());
          return { refreshed: 1, skipped: 0, failed: 0, dropped: 2 };
        },
      ),
    };
  }

  const signal = new AbortController().signal;

  for (const level of [1, 2, 4, 8, 16]) {
    it(`a changed key at ${level}x reads again the slabs of all three orientations and the cube that meet it, and nothing else`, async () => {
      const { routes } = setup();
      withState(routes, 5);
      // The changed key 1, 2, 3 (z, y, x) covers x 96..128, y 64..96, z 32..64
      // in voxels of its level.
      const sources = [
        source(
          level,
          [256, 256, 1],
          [
            [0, 0, 31],
            [0, 0, 32],
            [0, 0, 63],
            [0, 0, 64],
            [1, 0, 40],
          ],
        ),
        source(
          level,
          [256, 1, 256],
          [
            [0, 63, 0],
            [0, 64, 0],
            [0, 95, 0],
            [0, 96, 0],
            [1, 70, 0],
          ],
        ),
        source(
          level,
          [1, 256, 256],
          [
            [95, 0, 0],
            [96, 0, 0],
            [127, 0, 0],
            [128, 0, 0],
            [100, 1, 0],
          ],
        ),
        source(
          level,
          [32, 32, 32],
          [
            [3, 2, 1],
            [2, 2, 1],
            [3, 2, 2],
          ],
        ),
        // The same layer at another level, and another layer at this level.
        source(level === 1 ? 2 : 1, [32, 32, 32], [[3, 2, 1]]),
        source(
          level,
          [32, 32, 32],
          [[3, 2, 1]],
          "http://cdn.test/data/u1/other",
        ),
      ];
      const queue = queueOf(sources);

      const result = await applyDraftMessage(
        queue,
        {
          kind: "changed",
          ...LAYER,
          generation: 6,
          prev: 5,
          changed: { [String(level)]: [[1, 2, 3]] },
        },
        signal,
        routes,
      );

      expect(Object.fromEntries(queue.invalidated)).toEqual({
        [`${level}x 256x256x1`]: ["0,0,32", "0,0,63"],
        [`${level}x 256x1x256`]: ["0,64,0", "0,95,0"],
        [`${level}x 1x256x256`]: ["127,0,0", "96,0,0"],
        [`${level}x 32x32x32`]: ["3,2,1"],
      });
      expect(result).toEqual({
        ignored: false,
        gap: false,
        older: false,
        have: 5,
        refreshed: 4,
        skipped: 0,
        failed: 0,
        dropped: 8,
      });
    });
  }

  it("a draft state reads again the chunks of the old and the new regions at every level", async () => {
    const { routes } = setup();
    withState(routes, 5, [[0, 0, 0]]);
    const sources = [
      source(
        1,
        [256, 256, 1],
        [
          [0, 0, 0],
          [0, 0, 127],
          [0, 0, 128],
          [1, 0, 0],
        ],
      ),
      source(
        16,
        [64, 64, 1],
        [
          [0, 0, 7],
          [0, 0, 8],
          [0, 0, 16],
        ],
      ),
    ];
    const queue = queueOf(sources);

    await applyDraftMessage(
      queue,
      { kind: "state", ...LAYER, generation: 9, regions: [[1, 0, 0]] },
      signal,
      routes,
    );

    expect(Object.fromEntries(queue.invalidated)).toEqual({
      "1x 256x256x1": ["0,0,0", "0,0,127", "0,0,128"],
      "16x 64x64x1": ["0,0,7", "0,0,8"],
    });
  });

  it("has the views work out again which chunks they want before it drops any", async () => {
    const { routes } = setup();
    const order: string[] = [];
    const coarse = {
      ...source(8, [256, 256, 1], [[0, 0, 0]]),
      chunkManager: {
        scheduleUpdateChunkPriorities: () => order.push("priorities"),
      },
    };
    const queue = queueOf([coarse]);
    queue.invalidateCachedChunks.mockImplementation(async () => {
      order.push("chunks");
      return { refreshed: 0, skipped: 0, failed: 0, dropped: 1 };
    });

    await applyDraftMessage(
      queue,
      { kind: "state", ...LAYER, generation: 1, regions: [[0, 0, 0]] },
      signal,
      routes,
    );

    expect(order).toEqual(["priorities", "chunks"]);
  });

  it("a repeat of the state the viewer has reads nothing", async () => {
    const { routes } = setup();
    withState(routes, 5);
    const queue = queueOf([source(1, [256, 256, 1], [[0, 0, 0]])]);

    const result = await applyDraftMessage(
      queue,
      { kind: "state", ...LAYER, generation: 5, regions: [[0, 0, 0]] },
      signal,
      routes,
    );

    expect(result).toMatchObject({ ignored: true, older: false, refreshed: 0 });
    expect(queue.invalidateCachedChunks).not.toHaveBeenCalled();
  });

  it("a release, a duplicate and an old copy read nothing", async () => {
    const { routes } = setup();
    withState(routes, 5);
    const queue = queueOf([source(1, [256, 256, 1], [[0, 0, 0]])]);
    const stroke = {
      kind: "changed" as const,
      ...LAYER,
      generation: 5,
      prev: 4,
      changed: { "1": [[0, 0, 0]] },
    };

    const old = await applyDraftMessage(queue, stroke, signal, routes);
    const released = await applyDraftMessage(
      queue,
      {
        kind: "released",
        ...LAYER,
        generation: 6,
        prev: 5,
        regions: [[0, 0, 0]],
      },
      signal,
      routes,
    );

    expect(old.ignored).toBe(true);
    expect(released).toMatchObject({
      ignored: false,
      gap: false,
      refreshed: 0,
    });
    expect(queue.invalidateCachedChunks).not.toHaveBeenCalled();
  });

  it("passes on a gap, with the generation the viewer had", async () => {
    const { routes } = setup();
    withState(routes, 5);
    const result = await applyDraftMessage(
      queueOf([]),
      {
        kind: "changed",
        ...LAYER,
        generation: 9,
        prev: 8,
        changed: { "1": [[0, 0, 0]] },
      },
      signal,
      routes,
    );
    expect(result).toMatchObject({ gap: true, have: 5 });
  });
});

describe("handleDraftWindowMessage", () => {
  const page = {};
  const stroke = {
    type: "draft_changed",
    ...LAYER,
    generation: 4,
    prev: 3,
    changed: { "1": [[0, 0, 0]] },
  };
  function env(result: Partial<DraftUpdateResult> = {}) {
    const posted: object[] = [];
    const e = {
      parent: page,
      invoke: vi.fn(async () => ({
        ignored: false,
        gap: false,
        older: false,
        have: 3,
        refreshed: 0,
        skipped: 0,
        failed: 0,
        dropped: 0,
        ...result,
      })),
      post: (m: object) => posted.push(m),
      redraw: vi.fn(),
    };
    return { e, posted };
  }

  it("hands a draft message of the embedding page to the worker and redraws", async () => {
    const { e, posted } = env();
    expect(handleDraftWindowMessage({ data: stroke, source: page }, e)).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(e.invoke).toHaveBeenCalledTimes(1);
    expect(e.invoke.mock.calls[0]).toEqual([
      {
        kind: "changed",
        ...LAYER,
        generation: 4,
        prev: 3,
        changed: { "1": [[0, 0, 0]] },
      },
    ]);
    expect(posted).toEqual([]);
    expect(e.redraw).toHaveBeenCalledTimes(1);
  });

  it("does not act on a draft message from any other window", async () => {
    const { e, posted } = env();
    expect(handleDraftWindowMessage({ data: stroke, source: {} }, e)).toBe(
      true,
    );
    expect(handleDraftWindowMessage({ data: stroke, source: null }, e)).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(e.invoke).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("leaves every other message to the rest of the listener", () => {
    const { e } = env();
    expect(
      handleDraftWindowMessage(
        { data: { type: "invalidate_chunks" }, source: page },
        e,
      ),
    ).toBe(false);
    expect(e.invoke).not.toHaveBeenCalled();
  });

  it("asks the page for the whole state after a gap", async () => {
    const { e, posted } = env({ gap: true, have: 2 });
    handleDraftWindowMessage({ data: stroke, source: page }, e);
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual([
      {
        type: "draft_state_request",
        layerItemId: "layer-1",
        location: "u1/seg",
        have: 2,
        reason: "gap",
      },
    ]);
  });

  it("asks the page again after a state that was older than what the viewer has", async () => {
    const { e, posted } = env({ ignored: true, older: true, have: 7 });
    handleDraftWindowMessage(
      {
        data: { type: "draft_state", ...LAYER, generation: 6, regions: [] },
        source: page,
      },
      e,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual([
      {
        type: "draft_state_request",
        layerItemId: "layer-1",
        location: "u1/seg",
        have: 7,
        reason: "older",
      },
    ]);
  });
});

describe("page messages", () => {
  it("reads the three kinds", () => {
    expect(
      draftMessage({
        type: "draft_state",
        ...LAYER,
        user: "u1",
        generation: 3,
        regions: [[0, 1, 2]],
      }),
    ).toEqual({ kind: "state", ...LAYER, generation: 3, regions: [[0, 1, 2]] });
    expect(
      draftMessage({
        type: "draft_changed",
        ...LAYER,
        generation: 4,
        prev: 3,
        changed: { "1": [[0, 0, 0]] },
      }),
    ).toEqual({
      kind: "changed",
      ...LAYER,
      generation: 4,
      prev: 3,
      changed: { "1": [[0, 0, 0]] },
    });
    expect(
      draftMessage({
        type: "draft_released",
        layerItemId: "layer-1",
        location: "u1/seg",
        generation: 5,
        prev: 4,
        regions: [],
      }),
    ).toEqual({
      kind: "released",
      layerItemId: "layer-1",
      location: "u1/seg",
      generation: 5,
      prev: 4,
      regions: [],
    });
  });

  it("takes nothing else for a draft message", () => {
    expect(draftMessage({ type: "invalidate_chunks" })).toBeUndefined();
    expect(draftMessage(null)).toBeUndefined();
    expect(
      draftMessage({ type: "draft_changed", location: "u1/seg" }),
    ).toBeUndefined();
    expect(
      draftMessage({ type: "draft_state", ...LAYER, generation: "3" }),
    ).toBeUndefined();
  });

  it("turns a notice into the message the page gets", () => {
    expect(
      noticeForPage({
        kind: "behind",
        layerItemId: "layer-1",
        location: "u1/seg",
        have: 4,
      }),
    ).toEqual({
      type: "draft_state_request",
      layerItemId: "layer-1",
      location: "u1/seg",
      have: 4,
      reason: "behind",
    });
    expect(
      noticeForPage({
        kind: "refused",
        layerItemId: "layer-1",
        location: "u1/seg",
        status: 401,
      }),
    ).toEqual({
      type: "draft_chunk_refused",
      layerItemId: "layer-1",
      location: "u1/seg",
      status: 401,
    });
  });
});
