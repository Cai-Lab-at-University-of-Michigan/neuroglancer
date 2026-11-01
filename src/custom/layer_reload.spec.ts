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
 * After a commit the page asks the viewer to refresh ONE layer without
 * emptying it (`invalidate_chunks` with `soft`), and the viewer answers with
 * `layer_reloaded` once the layer shows the new data. In the same frame as the
 * new data it hides the draft layer, which would otherwise be drawn over the
 * committed layer for as long as the page takes to remove it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DraftHider,
  type LayerLike,
  type RefreshReply,
  type RefreshResult,
  type ViewerLike,
  findLayerSources,
  handleSoftInvalidate,
} from "#src/custom/layer_reload.js";

function layer(name: string, visible = true): LayerLike {
  const l: LayerLike = {
    name,
    visible,
    setVisible(value: boolean) {
      l.visible = value;
    },
  };
  return l;
}

type FakeSource = {
  id: string;
  refreshCache: ReturnType<typeof vi.fn>;
  invalidateCache: ReturnType<typeof vi.fn>;
};

function source(
  id: string,
  answer: Partial<RefreshResult> | Error | "never" = {},
): FakeSource {
  return {
    id,
    invalidateCache: vi.fn(),
    refreshCache: vi.fn(async () => {
      if (answer === "never") return new Promise<RefreshResult>(() => {});
      if (answer instanceof Error) throw answer;
      return {
        refreshed: 2,
        skipped: 0,
        failed: 0,
        fellBack: false,
        ...answer,
      };
    }),
  };
}

/** A viewer with one panel; `shows` maps a managed layer's name to its sources. */
function fakeViewer(
  layers: LayerLike[],
  shows: Record<string, FakeSource[][]>,
  calls: string[] = [],
  panelCount = 1,
) {
  let changed: (() => void)[] = [];
  const panels = Array.from({ length: panelCount }, () => {
    const renderLayers = Object.keys(shows).map((name) => ({
      userLayer: { managedLayer: { name } },
    }));
    const visibleLayers = new Map<
      object,
      { allSources: { source: FakeSource }[][] }
    >();
    renderLayers.forEach((rl, i) => {
      visibleLayers.set(rl, {
        allSources: shows[Object.keys(shows)[i]].map((row) =>
          row.map((s) => ({ source: s })),
        ),
      });
    });
    return { sliceView: { visibleLayerList: renderLayers, visibleLayers } };
  });
  const viewer: ViewerLike = {
    display: {
      panels: new Set(panels),
      scheduleRedraw: vi.fn(() => {
        calls.push("redraw");
      }),
    },
    layerManager: {
      getLayerByName: (name: string) => layers.find((l) => l.name === name),
      layersChanged: {
        add(cb: () => void) {
          changed.push(cb);
          return () => {
            changed = changed.filter((c) => c !== cb);
          };
        },
      },
    },
    chunkQueueManager: {
      beginRefreshHold: vi.fn(() => {
        calls.push("hold");
      }),
      endRefreshHold: vi.fn(() => {
        calls.push("release");
        return 0;
      }),
    },
  };
  return {
    viewer,
    layers,
    fireLayersChanged: () => changed.slice().forEach((cb) => cb()),
  };
}

function env(calls: string[], timeoutMs = 1000) {
  const posted: RefreshReply[] = [];
  return {
    posted,
    env: {
      post: (m: RefreshReply) => {
        calls.push("reply");
        posted.push(m);
      },
      frames: async () => {
        calls.push("frames");
      },
      timeoutMs,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("findLayerSources", () => {
  it("finds the sources of the layer with that name and no others", () => {
    const a = source("a");
    const b = source("b");
    const other = source("other");
    const { viewer } = fakeViewer(
      [layer("committed"), layer("draft"), layer("another")],
      { committed: [[a, b]], another: [[other]] },
    );

    const found = findLayerSources(viewer, "committed");

    expect(found.map((s) => (s as unknown as FakeSource).id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("lists a source once when several panels show it", () => {
    const a = source("a");
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[a]] },
      [],
      3,
    );

    expect(findLayerSources(viewer, "committed")).toHaveLength(1);
  });

  it("finds nothing for a layer that is not drawn", () => {
    const { viewer } = fakeViewer([layer("committed")], {
      committed: [[source("a")]],
    });

    expect(findLayerSources(viewer, "not there")).toEqual([]);
  });
});

describe("handleSoftInvalidate", () => {
  it("refreshes every source of the named layer, and nothing else", async () => {
    const calls: string[] = [];
    const committed = [source("a"), source("b")];
    const untouched = source("other");
    const { viewer } = fakeViewer(
      [layer("committed"), layer("draft"), layer("another")],
      { committed: [committed], another: [[untouched]] },
      calls,
    );
    const { env: e } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    for (const s of committed) expect(s.refreshCache).toHaveBeenCalledTimes(1);
    expect(untouched.refreshCache).not.toHaveBeenCalled();
    for (const s of [...committed, untouched]) {
      expect(
        s.invalidateCache,
        "the old whole-layer path ran",
      ).not.toHaveBeenCalled();
    }
  });

  it("puts the new data on screen and hides the draft in one step, then answers", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    draft.setVisible = vi.fn((v: boolean) => {
      calls.push(`draft visible=${v}`);
      draft.visible = v;
    });
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("a"), source("b")]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    // replacements held while the sources refresh, applied and the draft hidden with nothing in
    // between (so with no frame in between), then drawn, then the reply
    expect(calls).toEqual([
      "hold",
      "release",
      "draft visible=false",
      "redraw",
      "frames",
      "reply",
    ]);
    expect(posted).toEqual([
      {
        type: "layer_reloaded",
        layerName: "committed",
        commitId: "c1",
        ok: true,
        refreshed: 4,
        failed: 0,
        timedOut: false,
        hidden: true,
      },
    ]);
    expect(draft.visible).toBe(false);
  });

  it("does not hide the draft when a chunk failed: the stroke would be left on nothing", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("a", { failed: 1, refreshed: 1 })]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(draft.visible).toBe(true);
    expect(posted[0]).toMatchObject({ ok: false, failed: 1, hidden: false });
  });

  it("falls back to the whole-layer path for a source whose refresh was refused", async () => {
    const calls: string[] = [];
    const broken = source("broken", new Error("rpc failed"));
    const fine = source("fine");
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[broken, fine]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(broken.invalidateCache).toHaveBeenCalledTimes(1);
    expect(fine.invalidateCache).not.toHaveBeenCalled();
    expect(draft.visible).toBe(true);
    expect(posted[0]).toMatchObject({ ok: false, failed: 1, hidden: false });
  });

  it("counts a source the worker had to refresh the old way as not done", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("a", { fellBack: true, refreshed: 0 })]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(draft.visible).toBe(true);
    expect(posted[0]).toMatchObject({ ok: false, hidden: false });
  });

  it("answers when the refresh takes too long, without hiding the draft", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("slow", "never")]] },
      calls,
    );
    const { env: e, posted } = env(calls, 8000);

    const running = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(7999);
    expect(posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await running;

    expect(posted[0]).toMatchObject({
      ok: false,
      timedOut: true,
      hidden: false,
    });
    expect(draft.visible).toBe(true);
  });

  it("is a plain success for a layer that is not in the viewer, and hides nothing", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {}, calls);
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(posted[0]).toMatchObject({ ok: true, refreshed: 0, hidden: false });
    expect(draft.visible, "the draft is all there is to show the stroke").toBe(
      true,
    );
  });

  it("hides nothing when no draft layer is named, or none exists", async () => {
    const calls: string[] = [];
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[source("a")]] },
      calls,
    );
    const first = env(calls);
    const second = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1" },
      first.env,
      new DraftHider(viewer.layerManager),
    );
    await handleSoftInvalidate(
      viewer,
      {
        layerName: "committed",
        commitId: "c2",
        hideLayerName: "no such draft",
      },
      second.env,
      new DraftHider(viewer.layerManager),
    );

    expect(first.posted[0]).toMatchObject({ ok: true, hidden: false });
    expect(second.posted[0]).toMatchObject({ ok: true, hidden: false });
  });

  it("does not hide a draft that was rebuilt while the refresh ran: that one holds the next stroke", async () => {
    // The server rebuilds the draft when the user starts drawing again; the layer of that name is
    // then a new one, and hiding it would hide the stroke being drawn.
    const calls: string[] = [];
    const first = layer("draft");
    const layers = [layer("committed"), first];
    let rebuilt: LayerLike | undefined;
    const slow = source("a");
    slow.refreshCache.mockImplementation(async () => {
      rebuilt = layer("draft");
      layers[1] = rebuilt;
      return { refreshed: 2, skipped: 0, failed: 0, fellBack: false };
    });
    const { viewer } = fakeViewer(layers, { committed: [[slow]] }, calls);
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(rebuilt?.visible, "the next stroke was hidden").toBe(true);
    expect(first.visible).toBe(true);
    expect(posted[0]).toMatchObject({ ok: true, hidden: false });
  });

  it("starts holding the replacements before it asks any source to refresh", async () => {
    const calls: string[] = [];
    const a = source("a");
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[a]] },
      calls,
    );
    const { env: e } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1" },
      e,
      new DraftHider(viewer.layerManager),
    );

    // a replacement that arrived before the hold began would be drawn on its own
    const hold = vi.mocked(viewer.chunkQueueManager.beginRefreshHold);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      a.refreshCache.mock.invocationCallOrder[0],
    );
  });

  it("ends the hold once, also when a source and its fallback both throw", async () => {
    const calls: string[] = [];
    const broken = source("broken", new Error("rpc failed"));
    broken.invalidateCache.mockImplementation(() => {
      throw new Error("the source is gone");
    });
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[broken, source("fine")]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    // a hold that is never ended keeps every later replacement off the screen
    expect(viewer.chunkQueueManager.endRefreshHold).toHaveBeenCalledTimes(1);
    expect(posted[0]).toMatchObject({ ok: false, hidden: false });
    expect(draft.visible).toBe(true);
  });

  it("ends the hold when it gives up waiting, so what has arrived is shown", async () => {
    const calls: string[] = [];
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[source("slow", "never")]] },
      calls,
    );
    const { env: e } = env(calls, 8000);

    const running = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1" },
      e,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(7999);
    expect(viewer.chunkQueueManager.endRefreshHold).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await running;

    expect(viewer.chunkQueueManager.endRefreshHold).toHaveBeenCalledTimes(1);
  });

  it("names the commit in the answer, so the page can tell which hold it ends", async () => {
    const calls: string[] = [];
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[source("a")]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "the-one" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(posted[0].commitId).toBe("the-one");
    expect(posted[0].layerName).toBe("committed");
  });
});

describe("DraftHider", () => {
  it("hides the named layer and says so, and says no for a layer that is not there", () => {
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {});
    const hider = new DraftHider(viewer.layerManager);

    expect(hider.hide("draft")).toBe(true);
    expect(draft.visible).toBe(false);
    expect(hider.hide("missing")).toBe(false);
  });

  it("does not hide a layer that is not the one it was told to expect", () => {
    const expected = layer("draft");
    const other = layer("draft");
    const { viewer } = fakeViewer([other], {});
    const hider = new DraftHider(viewer.layerManager);

    expect(hider.hide("draft", expected)).toBe(false);

    expect(other.visible).toBe(true);
  });

  it("hides the layer it was told to expect", () => {
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {});
    const hider = new DraftHider(viewer.layerManager);

    expect(hider.hide("draft", draft)).toBe(true);

    expect(draft.visible).toBe(false);
  });

  it("shows the same layer again after the safety time", () => {
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    vi.advanceTimersByTime(19_999);
    expect(draft.visible).toBe(false);
    vi.advanceTimersByTime(2);

    expect(draft.visible).toBe(true);
  });

  it("forgets a layer that was replaced: the new one is not touched by the old timer", () => {
    const old = layer("draft");
    const layers = [old];
    const { viewer, fireLayersChanged } = fakeViewer(layers, {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    // the server released the hold: the draft layer is a new, visible layer
    const replacement = layer("draft");
    layers[0] = replacement;
    fireLayersChanged();
    replacement.setVisible(false); // the user hid it
    vi.advanceTimersByTime(60_000);

    expect(
      replacement.visible,
      "the old timer showed a layer it did not hide",
    ).toBe(false);
  });

  it("shows a replacement that came up hidden, which only a stale echo of the hide can cause", () => {
    const old = layer("draft");
    const layers = [old];
    const { viewer, fireLayersChanged } = fakeViewer(layers, {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    const replacement = layer("draft", false);
    layers[0] = replacement;
    fireLayersChanged();

    expect(replacement.visible).toBe(true);
  });

  it("forgets a layer that was removed", () => {
    const old = layer("draft");
    const layers = [old];
    const { viewer, fireLayersChanged } = fakeViewer(layers, {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    layers.length = 0;
    fireLayersChanged();
    vi.advanceTimersByTime(60_000);

    expect(old.visible, "a layer that left the viewer was shown").toBe(false);
  });

  it("a second hide starts the safety time over", () => {
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");
    vi.advanceTimersByTime(15_000);

    hider.hide("draft");
    vi.advanceTimersByTime(15_000);
    expect(draft.visible).toBe(false);
    vi.advanceTimersByTime(5_001);

    expect(draft.visible).toBe(true);
  });

  it("stops listening and drops its timers when it is disposed", () => {
    const draft = layer("draft");
    const { viewer } = fakeViewer([draft], {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    hider.dispose();
    vi.advanceTimersByTime(60_000);

    expect(draft.visible).toBe(false);
  });
});
