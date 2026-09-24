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

import { describe, expect, it } from "vitest";

import type { PanelProjection, ProbeSample } from "#src/custom/prompt_probe.js";
import {
  COLLAPSE_MIN_DURATION_MS,
  COLLAPSE_MIN_SAMPLES,
  COLLAPSE_MIN_SPAN_PX,
  MAX_RECORDS,
  PromptProbe,
  collapseVerdict,
  panelPixelOfPosition,
} from "#src/custom/prompt_probe.js";
import { mat4 } from "#src/util/geom.js";

/** A pointer moving right one pixel every 16 ms, recording where it is. */
function healthyStroke(n: number): ProbeSample[] {
  return Array.from({ length: n }, (_, i) => ({
    screenX: 100 + 3 * i,
    screenY: 50,
    point: { x: 10 + 0.3 * i, y: 5, z: 7 },
    t: 16 * i,
  }));
}

/** The reported failure: pen-down right, every later reading one value. */
function lineToFixedPoint(n: number): ProbeSample[] {
  const stroke = healthyStroke(n);
  const fixed = { x: 400.5, y: 12.25, z: 7 };
  return stroke.map((s, i) => (i === 0 ? s : { ...s, point: { ...fixed } }));
}

describe("collapseVerdict", () => {
  it("stays quiet on a healthy stroke", () => {
    const v = collapseVerdict(healthyStroke(40));
    expect(v.shape).toBeNull();
    expect(v.distinctPointsAfterDown).toBe(39);
  });

  it("names the reported shape: a line from pen-down to one fixed point", () => {
    const v = collapseVerdict(lineToFixedPoint(40));
    expect(v.shape).toBe("line-to-fixed-point");
    expect(v.samplesAfterDown).toBe(39);
    expect(v.distinctPointsAfterDown).toBe(1);
  });

  it("tells a fully frozen stroke apart from the line", () => {
    const stroke = healthyStroke(40).map((s) => ({
      ...s,
      point: { x: 1, y: 2, z: 3 },
    }));
    expect(collapseVerdict(stroke).shape).toBe("whole-stroke-frozen");
  });

  it("stays quiet when the pointer did not travel far enough to matter", () => {
    // Same frozen readings, but the pointer only moved a few pixels, which a
    // healthy pipeline can also produce (one pick behind, 30 ms throttle).
    const stroke = lineToFixedPoint(40).map((s) => ({ ...s, screenX: 100 }));
    expect(collapseVerdict(stroke).shape).toBeNull();
  });

  it("stays quiet on a flick too short or too quick to judge", () => {
    // One reading short of enough after pen-down, but far and slow enough, so
    // the count is the only thing holding it back.
    const few = lineToFixedPoint(COLLAPSE_MIN_SAMPLES).map((s, i) => ({
      ...s,
      screenX: 100 + 30 * i,
      t: 50 * i,
    }));
    expect(collapseVerdict(few).shape).toBeNull();

    const quick = lineToFixedPoint(40).map((s) => ({ ...s, t: s.t / 100 }));
    expect(quick[quick.length - 1].t).toBeLessThan(COLLAPSE_MIN_DURATION_MS);
    expect(collapseVerdict(quick).shape).toBeNull();
  });

  it("fires at exactly the thresholds, so they mean what they say", () => {
    // Pen-down plus COLLAPSE_MIN_SAMPLES readings, the last one exactly at the
    // span and duration floors.
    const n = COLLAPSE_MIN_SAMPLES + 1;
    const stroke: ProbeSample[] = Array.from({ length: n }, (_, i) => ({
      screenX: (COLLAPSE_MIN_SPAN_PX * i) / (n - 1),
      screenY: 0,
      point: i === 0 ? { x: 0, y: 0, z: 0 } : { x: 9, y: 9, z: 0 },
      t: (COLLAPSE_MIN_DURATION_MS * i) / (n - 1),
    }));
    expect(collapseVerdict(stroke).shape).toBe("line-to-fixed-point");
  });

  it("answers null for a bare click", () => {
    expect(collapseVerdict(healthyStroke(1)).shape).toBeNull();
    expect(collapseVerdict([]).shape).toBeNull();
  });
});

/**
 * An orthographic view of a 200 x 100 voxel region onto a 200 x 100 pixel
 * panel, one voxel per pixel, y pointing down the screen the way the viewer
 * draws it. Built by hand, not by the function under test, so the expected
 * pixel of any voxel can be read straight off: voxel (a, b) is pixel (a, b).
 */
function oneToOneProjection(): PanelProjection {
  const m = mat4.create();
  // ndc.x = x / 100 - 1, ndc.y = 1 - y / 50
  mat4.set(m, 0.01, 0, 0, 0, 0, -0.02, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1);
  return {
    width: 200,
    height: 100,
    logicalWidth: 200,
    logicalHeight: 100,
    visibleLeftFraction: 0,
    visibleTopFraction: 0,
    viewProjectionMat: m,
  };
}

describe("panelPixelOfPosition", () => {
  it("puts a voxel on the pixel a hand-built one-to-one view says", () => {
    const px = panelPixelOfPosition(
      [50, 25, 3],
      [0, 1, 2],
      3,
      oneToOneProjection(),
    );
    expect(px!.x).toBeCloseTo(50, 6);
    expect(px!.y).toBeCloseTo(25, 6);
  });

  it("reads the display dimensions out of a position stored in another order", () => {
    // The global coordinate space is not always x, y, z. Stored as [z, y, x],
    // x is index 2 and is the first display dimension.
    const px = panelPixelOfPosition(
      [3, 25, 50],
      [2, 1, 0],
      3,
      oneToOneProjection(),
    );
    expect(px!.x).toBeCloseTo(50, 6);
    expect(px!.y).toBeCloseTo(25, 6);
  });

  it("adds back the part of the panel that is scrolled off the canvas", () => {
    // A panel 400 px wide of which the right 200 are visible: GL pixel 0 is
    // panel pixel 200 (rendered_data_panel.ts issuePickRequestInternal:
    // glWindowX = mouseX - visibleLeftFraction * logicalWidth).
    const p = {
      ...oneToOneProjection(),
      logicalWidth: 400,
      visibleLeftFraction: 0.5,
    };
    const px = panelPixelOfPosition([50, 25, 3], [0, 1, 2], 3, p);
    expect(px!.x).toBeCloseTo(250, 6);
    expect(px!.y).toBeCloseTo(25, 6);
  });

  it("gives null rather than a number when the position is not finite", () => {
    expect(
      panelPixelOfPosition([NaN, 25, 3], [0, 1, 2], 3, oneToOneProjection()),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The live half, against a stand-in viewer. These check what the probe PRINTS
// and when; they do not reproduce the failure itself, which needs Neuroglancer's
// WebGL pick pipeline and cannot run here.

function signal() {
  const listeners: (() => void)[] = [];
  return {
    add(fn: () => void) {
      listeners.push(fn);
      return () => {};
    },
    dispatch() {
      for (const fn of listeners) fn();
    },
  };
}

function fakePanel(mouseX = -1) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return {
    element,
    mouseX,
    mouseY: mouseX,
    pickRequestPending: false,
    wasDisposed: undefined as boolean | undefined,
    pickRequests: [],
    pickingData: [{ frameNumber: 0 }, { frameNumber: 0 }],
    completePickRequest(..._args: unknown[]) {},
    sliceView: {
      valid: true,
      projectionParameters: { value: { ...oneToOneProjection() } },
    },
    navigationState: {
      pose: {
        displayDimensions: {
          value: { displayDimensionIndices: [0, 1, 2], displayRank: 3 },
        },
      },
    },
  };
}

function fakeViewer(panels: any[]) {
  const coordinateSpaceValue = { names: ["x", "y", "z"] };
  return {
    display: { panels: new Set(panels), changed: signal(), frameNumber: 0 },
    mouseState: {
      position: new Float32Array([50, 25, 3]),
      active: true,
      pageX: 50,
      pageY: 25,
      coordinateSpace: coordinateSpaceValue,
      changed: signal(),
    },
    layerManager: { layersChanged: signal() },
    coordinateSpace: {
      value: {
        ...coordinateSpaceValue,
        valid: true,
        bounds: { lowerBounds: [0, 0, 0], upperBounds: [200, 100, 10] },
      },
      changed: signal(),
    },
  };
}

function pointerAt(target: EventTarget, x: number, y: number): MouseEvent {
  // jsdom lays nothing out, so every element's rect is at 0,0: client and
  // panel coordinates coincide.
  return {
    target,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
  } as unknown as MouseEvent;
}

function harness(panels = [fakePanel(50)]) {
  const viewer = fakeViewer(panels);
  const lines: string[] = [];
  let clock = 0;
  const probe = new PromptProbe(
    viewer,
    { commit: "test", bundle: "test" },
    () => clock,
    (line) => lines.push(line),
  );
  const tick = (ms: number) => {
    clock += ms;
  };
  return { viewer, probe, lines, tick, panel: panels[0] };
}

function drawStroke(
  h: ReturnType<typeof harness>,
  pointAt: (i: number) => { x: number; y: number; z: number },
  n = 30,
) {
  h.probe.begin("lasso", pointerAt(h.panel.element, 50, 25), pointAt(0), {
    x: 50,
    y: 25,
  });
  for (let i = 1; i < n; ++i) {
    h.tick(16);
    h.probe.sample({ x: 50 + 3 * i, y: 25 }, pointAt(i));
  }
  h.probe.end();
}

const moving = (i: number) => ({ x: 50 + 3 * i, y: 25, z: 3 });
const stuckAfterDown = (i: number) =>
  i === 0 ? moving(0) : { x: 400, y: 12, z: 3 };

function record(line: string) {
  return JSON.parse(line.slice(line.indexOf("{")));
}

describe("PromptProbe", () => {
  it("prints one baseline for the first healthy stroke, then stays quiet", () => {
    const h = harness();
    drawStroke(h, moving);
    drawStroke(h, moving);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("[prompt-probe] baseline ");
    expect(record(h.lines[0]).penDownOffsetPx).toBeCloseTo(0, 3);
  });

  it("prints the reported shape with the fields asked for", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    drawStroke(h, stuckAfterDown);
    expect(h.lines).toHaveLength(2);
    const r = record(h.lines[1]);
    expect(r.finding).toBe("line-to-fixed-point");
    expect(r.mode).toBe("lasso");
    expect(r.down.panelUnderPointer).toBe(0);
    expect(r.panels[0]).toMatchObject({
      underPointer: true,
      disposed: false,
      connected: true,
    });
    expect(r.down.mouseState.position).toEqual([50, 25, 3]);
    expect(r.msSince).toHaveProperty("panelSetChange");
  });

  it("dates the last layout change from the moment the panel set changed", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    h.tick(1000);
    const rebuilt = fakePanel(50);
    h.viewer.display.panels = new Set([rebuilt]);
    h.viewer.display.changed.dispatch();
    h.tick(250);
    h.panel = rebuilt;
    drawStroke(h, stuckAfterDown);
    const r = record(h.lines[1]);
    expect(r.countsSincePageLoad.panelSetChanges).toBe(1);
    // 250 ms before pen-down, plus the stroke itself (29 readings x 16 ms).
    expect(r.msSince.panelSetChange).toBe(250 + 29 * 16);
  });

  it("flags pen-down away from the pointer, which is the point and box case", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    h.viewer.mouseState.position = new Float32Array([150, 80, 3]);
    h.probe.begin(
      "point",
      pointerAt(h.panel.element, 50, 25),
      { x: 150, y: 80, z: 3 },
      { x: 50, y: 25 },
    );
    h.probe.end();
    const r = record(h.lines[1]);
    expect(r.finding).toBe("pen-down-away-from-pointer");
    expect(r.penDownOffsetPx).toBeCloseTo(Math.hypot(100, 55), 1);
  });

  it("says when the recorded point was snapped onto a picked annotation", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    const seedRenderLayer = {};
    (h.viewer as any).layerManager.managedLayers = [
      { name: "image", layer: { renderLayers: [{}] } },
      { name: "__seeds_pos", layer: { renderLayers: [seedRenderLayer] } },
    ];
    Object.assign(h.viewer.mouseState, {
      position: new Float32Array([400, 12, 3]),
      unsnappedPosition: new Float32Array([140, 25, 3]),
      pickedRenderLayer: seedRenderLayer,
      pickedAnnotationId: "a1",
    });
    drawStroke(h, stuckAfterDown);
    const r = record(h.lines[1]);
    expect(r.mouseStateAtEnd).toMatchObject({
      position: [400, 12, 3],
      unsnappedPosition: [140, 25, 3],
      pickedLayer: "__seeds_pos",
      pickedAnnotationId: "a1",
    });
  });

  it("names the panel whose pick wrote the recorded value, including a stale one", () => {
    // Two panels: the one being drawn on, and one the pointer left long ago
    // that still holds mouseX >= 0 and keeps picking at that pixel.
    const drawnOn = fakePanel(50);
    const stale = fakePanel(30);
    const h = harness([drawnOn, stale]);
    drawStroke(h, moving); // baseline
    h.probe.begin("lasso", pointerAt(drawnOn.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    drawnOn.completePickRequest();
    for (let i = 1; i < 30; ++i) {
      stale.completePickRequest();
      h.tick(16);
      h.probe.sample({ x: 50 + 3 * i, y: 25 }, stuckAfterDown(i));
    }
    h.probe.end();
    const r = record(h.lines[1]);
    expect(r.finding).toBe("line-to-fixed-point");
    expect(r.panels[0]).toMatchObject({
      underPointer: true,
      lastWriter: false,
      writesDuringStroke: 1,
    });
    expect(r.panels[1]).toMatchObject({
      underPointer: false,
      mouseX: 30,
      lastWriter: true,
      writesDuringStroke: 29,
    });
    expect(r.lastWriterIsLivePanel).toBe(true);
  });

  it("says when the last writer is a panel no longer in the display", () => {
    const h = harness();
    const ghost = fakePanel(30);
    h.viewer.display.panels.add(ghost);
    h.viewer.display.changed.dispatch(); // the probe sees, and wraps, it
    h.viewer.display.panels.delete(ghost);
    h.viewer.display.changed.dispatch();
    ghost.completePickRequest();
    drawStroke(h, moving);
    expect(record(h.lines[0]).lastWriterIsLivePanel).toBe(false);
  });

  it("still calls the panel's own completePickRequest, with its arguments", () => {
    const calls: unknown[][] = [];
    const panel = fakePanel(50);
    panel.completePickRequest = function (...args: unknown[]) {
      calls.push(args);
    };
    harness([panel]);
    panel.completePickRequest(1, 2, "data");
    expect(calls).toEqual([[1, 2, "data"]]);
  });

  it("carries the coordinate space's validity and the handler's own state", () => {
    const lines: string[] = [];
    const viewer = fakeViewer([fakePanel(50)]);
    (viewer.coordinateSpace.value as any).valid = false;
    const probe = new PromptProbe(
      viewer,
      { commit: "t", bundle: "t" },
      () => 0,
      (l) => lines.push(l),
      () => ({ staleCachedSources: ["pos"] }),
    );
    const panel = [...viewer.display.panels][0];
    probe.begin("point", pointerAt(panel.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    probe.end();
    const r = record(lines[0]);
    expect(r.down.mouseState.coordinateSpaceValid).toBe(false);
    expect(r.handler).toEqual({ staleCachedSources: ["pos"] });
  });

  it("flags pen-down on an element that is not a live panel", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    h.panel.wasDisposed = true;
    h.probe.begin("point", pointerAt(h.panel.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    h.probe.end();
    const r = record(h.lines[1]);
    expect(r.finding).toBe("pen-down-not-on-a-live-panel");
    expect(r.panels[0].disposed).toBe(true);
  });

  it("names a stroke whose mouseup never arrived", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    h.probe.begin("lasso", pointerAt(h.panel.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    h.probe.begin("lasso", pointerAt(h.panel.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    expect(record(h.lines[1]).finding).toBe("stroke-never-ended");
  });

  it("counts readings the handler threw away, by reason", () => {
    const h = harness();
    h.probe.begin("lasso", pointerAt(h.panel.element, 50, 25), moving(0), {
      x: 50,
      y: 25,
    });
    h.probe.reject("offPanel");
    h.probe.reject("offPanel");
    h.probe.reject("outsideData");
    h.probe.end();
    expect(record(h.lines[0]).stroke.rejected).toEqual({
      offPanel: 2,
      outsideData: 1,
    });
  });

  it("stops printing after the cap and says so once", () => {
    const h = harness();
    drawStroke(h, moving); // baseline
    for (let i = 0; i < MAX_RECORDS + 5; ++i) drawStroke(h, stuckAfterDown);
    expect(h.lines).toHaveLength(MAX_RECORDS + 1);
    expect(h.lines[MAX_RECORDS]).toContain(
      "further ones are counted, not printed",
    );
  });

  it("never throws into the handler, even on a viewer missing everything", () => {
    const lines: string[] = [];
    const probe = new PromptProbe(
      {},
      { commit: "t", bundle: "t" },
      () => 0,
      (l) => lines.push(l),
    );
    expect(() => {
      probe.begin("point", pointerAt(document.body, 0, 0), moving(0), {
        x: 0,
        y: 0,
      });
      probe.sample({ x: 1, y: 1 }, moving(1));
      probe.reject("offPanel");
      probe.end();
    }).not.toThrow();
  });
});
