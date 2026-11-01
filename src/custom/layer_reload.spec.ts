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

import { UpdateHold } from "#src/chunk_manager/soft_refresh.js";
import {
  DraftHider,
  type LayerLike,
  RunningRefreshes,
  type RefreshReply,
  type RefreshResult,
  type ViewerLike,
  findLayerSources,
  handleSoftInvalidate,
  softInvalidateRequest,
  startSoftInvalidate,
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

/** A read that never answers, and fails when it is cancelled, as the real call does. */
const hang = (signal?: AbortSignal) =>
  new Promise<RefreshResult>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

function source(
  id: string,
  answer: Partial<RefreshResult> | Error | "never" | "hang" = {},
): FakeSource {
  return {
    id,
    invalidateCache: vi.fn(),
    refreshCache: vi.fn(async (signal?: AbortSignal) => {
      if (answer === "never") return new Promise<RefreshResult>(() => {});
      if (answer === "hang") return hang(signal);
      if (answer instanceof Error) throw answer;
      return {
        refreshed: 2,
        skipped: 0,
        failed: 0,
        fellBack: false,
        superseded: false,
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

function env(calls: string[], timeoutMs = 1000, abortAfterMs = 60_000) {
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
      abortAfterMs,
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

  it("is not ok for a layer that is not in the viewer: nothing was refreshed, and the draft is all that shows the stroke", async () => {
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

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false, refreshed: 0, hidden: false });
    expect(draft.visible).toBe(true);
    expect(viewer.chunkQueueManager.beginRefreshHold).not.toHaveBeenCalled();
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

  it("survives the page's state sync, which removes every layer and adds them all again", () => {
    // What really happens in SAVAII when the page releases the hold: the viewer
    // restores a state in which the draft is a new, empty layer, and does it
    // by clearing the layer list and adding every layer again.
    const old = layer("draft");
    const layers: LayerLike[] = [layer("committed"), old];
    const { viewer, fireLayersChanged } = fakeViewer(layers, {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    layers.length = 0;
    fireLayersChanged();
    const replacement = layer("draft");
    const setVisible = vi.spyOn(replacement, "setVisible");
    layers.push(layer("committed"), replacement);
    fireLayersChanged();
    vi.advanceTimersByTime(60_000);

    // the old record is gone: no timer shows or hides anything afterwards
    expect(vi.getTimerCount()).toBe(0);
    expect(replacement.visible).toBe(true);
    expect(setVisible).not.toHaveBeenCalled();
    expect(old.visible, "the layer that left was shown again").toBe(false);
  });

  it("shows the same layer after the safety time when nothing rebuilds the layers", () => {
    // the other case the timer is for: a page that never ends the hold
    const draft = layer("draft");
    const { viewer } = fakeViewer([layer("committed"), draft], {});
    const hider = new DraftHider(viewer.layerManager, 20_000);
    hider.hide("draft");

    vi.advanceTimersByTime(20_001);

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

describe("softInvalidateRequest", () => {
  it("reads the fields of a soft invalidate_chunks message", () => {
    expect(
      softInvalidateRequest({
        type: "invalidate_chunks",
        soft: true,
        layerName: "committed",
        commitId: "c1",
        hideLayerName: "draft",
        layerId: "not needed",
      }),
    ).toEqual({
      layerName: "committed",
      commitId: "c1",
      hideLayerName: "draft",
    });
  });

  it("leaves out a draft name that is not a string", () => {
    expect(
      softInvalidateRequest({
        soft: true,
        layerName: "committed",
        commitId: "c1",
        hideLayerName: 5,
      }),
    ).toEqual({ layerName: "committed", commitId: "c1" });
  });

  it.each([
    ["is not soft", { layerName: "committed", commitId: "c1" }],
    [
      "says soft but not true",
      { soft: "yes", layerName: "committed", commitId: "c1" },
    ],
    ["names no layer", { soft: true, commitId: "c1" }],
    ["names no commit", { soft: true, layerName: "committed" }],
    ["is empty", undefined],
  ])(
    "is nothing for a message that %s: the old invalidation takes it",
    (_why, data) => {
      expect(softInvalidateRequest(data)).toBeUndefined();
    },
  );
});

describe("startSoftInvalidate", () => {
  it("declines a layer with no source in the viewer, tells the page it got no refresh, and leaves the whole-layer invalidation to the caller", () => {
    // the layer was renamed in the viewer, or the scene gave it a " (2)" suffix: no source has its name
    const calls: string[] = [];
    const { viewer } = fakeViewer(
      [layer("committed (2)"), layer("draft")],
      { "committed (2)": [[source("o")]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    const started = startSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(started).toBe(false);
    expect(posted).toEqual([
      {
        type: "layer_reloaded",
        layerName: "committed",
        commitId: "c1",
        ok: false,
        refreshed: 0,
        failed: 0,
        timedOut: false,
        hidden: false,
      },
    ]);
    expect(viewer.chunkQueueManager.beginRefreshHold).not.toHaveBeenCalled();
  });

  it("starts the refresh of a layer that has a source, and answers when it is done", async () => {
    const calls: string[] = [];
    const a = source("a");
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[a]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    const started = startSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1" },
      e,
      new DraftHider(viewer.layerManager),
    );
    await vi.runAllTimersAsync();

    expect(started).toBe(true);
    expect(a.refreshCache).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: true });
  });
});

describe("one answer for every message", () => {
  const message = {
    layerName: "committed",
    commitId: "c1",
    hideLayerName: "draft",
  };

  async function run(
    breakIt: (parts: {
      viewer: ViewerLike;
      draft: LayerLike;
      e: ReturnType<typeof env>["env"];
    }) => void,
  ) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("a")]] },
      calls,
    );
    const { env: e, posted } = env(calls);
    breakIt({ viewer, draft, e });
    await handleSoftInvalidate(
      viewer,
      message,
      e,
      new DraftHider(viewer.layerManager),
    );
    return { viewer, posted };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers not ok, once, when the hold cannot be started", async () => {
    const { viewer, posted } = await run(({ viewer }) => {
      viewer.chunkQueueManager.beginRefreshHold = vi.fn(() => {
        throw new Error("no queue manager");
      });
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false, hidden: false });
    // a hold that never began is not ended
    expect(viewer.chunkQueueManager.endRefreshHold).not.toHaveBeenCalled();
  });

  it("answers not ok, once, when the replacements cannot be put on screen", async () => {
    const { posted } = await run(({ viewer }) => {
      viewer.chunkQueueManager.endRefreshHold = vi.fn(() => {
        throw new Error("a chunk update failed");
      });
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false });
  });

  it("answers not ok, once, when the redraw fails", async () => {
    const { posted } = await run(({ viewer }) => {
      viewer.display.scheduleRedraw = vi.fn(() => {
        throw new Error("no display");
      });
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false });
  });

  it("answers not ok, once, when the frames cannot be waited for", async () => {
    const { posted } = await run(({ e }) => {
      e.frames = async () => {
        throw new Error("no frames");
      };
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false });
  });

  it("answers not ok, once, when hiding the draft fails", async () => {
    const { posted } = await run(({ draft }) => {
      draft.setVisible = () => {
        throw new Error("layer is gone");
      };
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false });
  });
});

describe("refreshes that overlap", () => {
  it("does not call a refresh ok when a newer refresh of the same source took it over", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      {
        committed: [
          [source("a", { superseded: true, refreshed: 0, skipped: 2 })],
        ],
      },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(posted[0]).toMatchObject({ ok: false, hidden: false });
    expect(draft.visible).toBe(true);
  });

  /** The queue manager's side of a hold, with the real UpdateHold and a record of what reached the screen. */
  function holdingQueue() {
    const hold = new UpdateHold<object, { id: string; refresh?: boolean }>();
    const onScreen: string[] = [];
    return {
      onScreen,
      beginRefreshHold: vi.fn(() => hold.begin()),
      endRefreshHold: vi.fn(() => {
        for (const update of hold.end()) onScreen.push(update.id);
        return 0;
      }),
      /** What the frontend does with a replacement that the worker sends. */
      arrives(chunkSource: object, id: string) {
        if (!hold.keep(chunkSource, { id, refresh: true })) onScreen.push(id);
      },
    };
  }

  it("has the replacements of a refresh on screen when it answers ok, although another refresh started before it finished", async () => {
    const calls: string[] = [];
    const queue = holdingQueue();
    const sourceA = source("a");
    const sourceB = source("b");
    const gate = {
      a: Promise.withResolvers<void>(),
      b: Promise.withResolvers<void>(),
    };
    sourceA.refreshCache.mockImplementation(async () => {
      await gate.a.promise;
      queue.arrives(sourceA, "A's replacement");
      return {
        refreshed: 1,
        skipped: 0,
        failed: 0,
        fellBack: false,
        superseded: false,
      };
    });
    sourceB.refreshCache.mockImplementation(async () => {
      await gate.b.promise;
      queue.arrives(sourceB, "B's replacement");
      return {
        refreshed: 1,
        skipped: 0,
        failed: 0,
        fellBack: false,
        superseded: false,
      };
    });
    const { viewer } = fakeViewer(
      [layer("layer A"), layer("layer B")],
      { "layer A": [[sourceA]], "layer B": [[sourceB]] },
      calls,
    );
    viewer.chunkQueueManager = queue;
    const first = env(calls);
    const second = env(calls);
    // what is on screen at the moment each answer is sent
    const seenAtAnswer: Record<string, string[]> = {};
    first.env.post = (m) => {
      seenAtAnswer.A = [...queue.onScreen];
      first.posted.push(m);
    };
    second.env.post = (m) => {
      seenAtAnswer.B = [...queue.onScreen];
      second.posted.push(m);
    };

    const a = handleSoftInvalidate(
      viewer,
      { layerName: "layer A", commitId: "A" },
      first.env,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(10);
    const b = handleSoftInvalidate(
      viewer,
      { layerName: "layer B", commitId: "B" },
      second.env,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(10);
    gate.a.resolve();
    await a;
    gate.b.resolve();
    await b;

    expect(first.posted[0]).toMatchObject({ ok: true });
    expect(
      seenAtAnswer.A,
      "the answer said ok while the replacement was still held back",
    ).toContain("A's replacement");
    expect(seenAtAnswer.B).toContain("B's replacement");
  });

  it("cancels the older refresh of a layer when a newer one starts, shows the newer one's replacements, and does not empty the sources the older one was reading", async () => {
    const calls: string[] = [];
    const queue = holdingQueue();
    const s = source("s");
    s.refreshCache
      .mockImplementationOnce(async (signal?: AbortSignal) => hang(signal))
      .mockImplementation(async () => {
        queue.arrives(s, "newer replacement");
        return {
          refreshed: 1,
          skipped: 0,
          failed: 0,
          fellBack: false,
          superseded: false,
        };
      });
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[s]] },
      calls,
    );
    viewer.chunkQueueManager = queue;
    const running = new RunningRefreshes();
    const first = env(calls);
    const second = env(calls);

    const older = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "older" },
      first.env,
      new DraftHider(viewer.layerManager),
      running,
    );
    await vi.advanceTimersByTimeAsync(10);
    const newer = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "newer" },
      second.env,
      new DraftHider(viewer.layerManager),
      running,
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([older, newer]);

    expect(s.refreshCache.mock.calls[0][0].aborted).toBe(true);
    expect(s.refreshCache.mock.calls[1][0].aborted).toBe(false);
    expect(
      s.invalidateCache,
      "a cancelled refresh emptied the source",
    ).not.toHaveBeenCalled();
    expect(first.posted[0]).toMatchObject({ commitId: "older", ok: false });
    expect(second.posted[0]).toMatchObject({ commitId: "newer", ok: true });
    expect(queue.onScreen).toContain("newer replacement");
  });
});

describe("what a cancelled or empty refresh says", () => {
  it("asks the newer refresh's sources first and cancels the older refresh after, so the worker sees the newer one begin before it sees the cancel", async () => {
    // The other way round, the cancelled refresh finds no newer one and drops
    // every chunk it had not replaced, and the newer refresh then finds a
    // layer with nothing on screen to refresh.
    const calls: string[] = [];
    const order: string[] = [];
    const s = source("s");
    s.refreshCache
      .mockImplementationOnce(async (signal?: AbortSignal) => {
        signal?.addEventListener("abort", () => order.push("older cancelled"));
        return hang(signal);
      })
      .mockImplementation(async () => {
        order.push("newer asked");
        return {
          refreshed: 1,
          skipped: 0,
          failed: 0,
          fellBack: false,
          superseded: false,
        };
      });
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[s]] },
      calls,
    );
    const running = new RunningRefreshes();

    const older = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "older" },
      env(calls).env,
      new DraftHider(viewer.layerManager),
      running,
    );
    await vi.advanceTimersByTimeAsync(10);
    const newer = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "newer" },
      env(calls).env,
      new DraftHider(viewer.layerManager),
      running,
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([older, newer]);

    expect(order).toEqual(["newer asked", "older cancelled"]);
  });

  it("does not call a refresh ok when it was cancelled, even if the worker answered it as an ordinary result", async () => {
    // the worker answers a cancelled refresh with what it had done: no failure
    const calls: string[] = [];
    const draft = layer("draft");
    const s = source("s");
    s.refreshCache.mockImplementation(async (signal?: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve()),
      );
      // some chunks were replaced before the cancel, so only the cancel makes it not ok
      return {
        refreshed: 2,
        skipped: 4,
        failed: 0,
        fellBack: false,
        superseded: false,
      };
    });
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[s]] },
      calls,
    );
    const running = new RunningRefreshes();
    const { env: e, posted } = env(calls);

    const older = handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "older", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
      running,
    );
    await vi.advanceTimersByTimeAsync(10);
    running.begin("committed", 60_000).cancelOlder();
    await vi.advanceTimersByTimeAsync(100);
    await older;

    expect(posted[0]).toMatchObject({ ok: false, hidden: false });
    expect(draft.visible).toBe(true);
  });

  it("does not call a refresh ok when it refreshed nothing: the layer had no chunk on screen, so hiding the draft would leave the stroke on nothing", async () => {
    const calls: string[] = [];
    const draft = layer("draft");
    const { viewer } = fakeViewer(
      [layer("committed"), draft],
      { committed: [[source("a", { refreshed: 0, skipped: 0 })]] },
      calls,
    );
    const { env: e, posted } = env(calls);

    await handleSoftInvalidate(
      viewer,
      { layerName: "committed", commitId: "c1", hideLayerName: "draft" },
      e,
      new DraftHider(viewer.layerManager),
    );

    expect(posted[0]).toMatchObject({ ok: false, refreshed: 0, hidden: false });
    expect(draft.visible).toBe(true);
  });
});

describe("cancelling the reads of a refresh", () => {
  const message = { layerName: "committed", commitId: "c1" };

  it("gives every source a signal that stays open while the refresh runs, and asks it to cancel nothing at the answer", async () => {
    const calls: string[] = [];
    const slow = source("slow", "hang");
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[slow]] },
      calls,
    );
    const { env: e, posted } = env(calls, 8000, 60_000);

    const running = handleSoftInvalidate(
      viewer,
      message,
      e,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(8001);
    await running;

    // the answer went out at 8 s: late chunks are still wanted, so the reads go on
    expect(posted[0]).toMatchObject({ ok: false, timedOut: true });
    expect(slow.refreshCache.mock.calls[0][0].aborted).toBe(false);
  });

  it("cancels the reads that are still running after the hard limit, and does not empty the source for that", async () => {
    const calls: string[] = [];
    const stuck = source("stuck", "hang");
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[stuck]] },
      calls,
    );
    const { env: e } = env(calls, 8000, 60_000);

    const running = handleSoftInvalidate(
      viewer,
      message,
      e,
      new DraftHider(viewer.layerManager),
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stuck.refreshCache.mock.calls[0][0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await running;

    expect(stuck.refreshCache.mock.calls[0][0].aborted).toBe(true);
    expect(stuck.invalidateCache).not.toHaveBeenCalled();
  });

  it("drops its timer when the refresh finishes", async () => {
    const calls: string[] = [];
    const { viewer } = fakeViewer(
      [layer("committed")],
      { committed: [[source("a")]] },
      calls,
    );
    const { env: e } = env(calls, 8000, 60_000);

    await handleSoftInvalidate(
      viewer,
      message,
      e,
      new DraftHider(viewer.layerManager),
    );

    // DraftHider has no timer yet (nothing hidden), so nothing may be left running
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("RunningRefreshes", () => {
  it("cancels the older refresh of a layer only when the newer one says so, and only that layer's", () => {
    const running = new RunningRefreshes();
    const first = running.begin("committed", 60_000);
    const other = running.begin("another", 60_000);

    const second = running.begin("committed", 60_000);
    expect(first.signal.aborted, "cancelled before the newer one asked").toBe(
      false,
    );
    second.cancelOlder();

    expect(first.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it("has nothing to cancel for the first refresh of a layer", () => {
    const running = new RunningRefreshes();
    const first = running.begin("committed", 60_000);

    first.cancelOlder();

    expect(first.signal.aborted).toBe(false);
  });

  it("cancels at the hard limit and not before", () => {
    const running = new RunningRefreshes();
    const refresh = running.begin("committed", 60_000);

    vi.advanceTimersByTime(59_999);
    expect(refresh.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2);

    expect(refresh.signal.aborted).toBe(true);
  });

  it("finish drops the timer and forgets the refresh, without touching a newer one", () => {
    const running = new RunningRefreshes();
    const first = running.begin("committed", 60_000);
    const second = running.begin("committed", 60_000);

    first.finish();
    second.cancelOlder();
    expect(second.signal.aborted).toBe(false);
    second.finish();

    expect(vi.getTimerCount()).toBe(0);
    // nothing is left to cancel
    const third = running.begin("committed", 60_000);
    third.cancelOlder();
    expect(third.signal.aborted).toBe(false);
    third.finish();
  });
});
