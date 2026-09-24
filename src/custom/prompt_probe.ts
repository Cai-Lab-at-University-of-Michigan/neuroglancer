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
 * A console record of the prompt-collapse failure, written at the moment it
 * happens, because nobody has been able to make it happen on demand.
 *
 * What was reported: partway through an nnInteractive session, prompts start
 * landing in the wrong place and stay wrong. A point or a box lands somewhere
 * other than the click, and a lasso or scribble comes out as a straight line
 * from where the stroke began to one fixed point.
 *
 * Every prompt coordinate is read from viewer.mouseState.position (voxelPoint
 * in drawing_tool_handler.ts). Neuroglancer writes that field when a panel's
 * pick request completes, and leaves the old value in place when it stops
 * tracking the mouse. So a stroke whose later points are all one value is what
 * that field looks like either when nothing is writing it, or when something is
 * writing the same value over and over. The record carries what is needed to
 * tell those apart.
 *
 * Nothing here changes what a prompt records or sends. It only reads.
 *
 * The decision and the geometry are plain functions so they can be tested
 * without WebGL; drawing_tool_handler.ts cannot be imported by a test.
 */

import type { mat4 } from "#src/util/geom.js";
import { vec3 } from "#src/util/geom.js";

export interface ProbePoint {
  x: number;
  y: number;
  z: number;
}

/** One reading taken while a prompt was being drawn. */
export interface ProbeSample {
  /** Pointer position relative to the viewer container, in CSS pixels. */
  screenX: number;
  screenY: number;
  /** What the prompt recorded for this reading. */
  point: ProbePoint;
  /** performance.now() when it was taken. */
  t: number;
}

// A stroke has to be long enough, far enough and slow enough that a healthy
// pick pipeline could not have handed every reading the same value. Picks are
// throttled to one per 30 ms (rendered_data_panel.ts pickRequestInterval) and
// the drawing tool reads one pick behind the pointer, so a very short flick can
// legitimately read one value twice. A real lasso is dozens of readings over
// most of a second, so these leave a wide margin on both sides.
export const COLLAPSE_MIN_SAMPLES = 5;
export const COLLAPSE_MIN_SPAN_PX = 20;
export const COLLAPSE_MIN_DURATION_MS = 100;

export type CollapseShape =
  /** Pen-down read one value and every later reading read another: the
   *  reported "straight line from the start to a fixed point". */
  | "line-to-fixed-point"
  /** Every reading, pen-down included, was the same value. */
  | "whole-stroke-frozen";

export interface CollapseVerdict {
  shape: CollapseShape | null;
  samplesAfterDown: number;
  distinctPointsAfterDown: number;
  screenSpanPx: number;
  durationMs: number;
}

function samePoint(a: ProbePoint, b: ProbePoint) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Did the pointer travel while the recorded position stood still?
 *
 * `samples[0]` is the pen-down reading. Exact equality is deliberate: a value
 * nothing is updating is copied out of the same Float32Array every time, so it
 * is bitwise identical, while a live one changes as soon as the pointer crosses
 * a pixel -- and the thresholds require it to have crossed many.
 */
export function collapseVerdict(samples: ProbeSample[]): CollapseVerdict {
  const verdict: CollapseVerdict = {
    shape: null,
    samplesAfterDown: Math.max(0, samples.length - 1),
    distinctPointsAfterDown: 0,
    screenSpanPx: 0,
    durationMs: 0,
  };
  if (samples.length < 2) return verdict;
  const down = samples[0];
  const after = samples.slice(1);
  const distinct: ProbePoint[] = [];
  for (const s of after) {
    if (!distinct.some((p) => samePoint(p, s.point))) distinct.push(s.point);
    const span = Math.hypot(s.screenX - down.screenX, s.screenY - down.screenY);
    if (span > verdict.screenSpanPx) verdict.screenSpanPx = span;
  }
  verdict.distinctPointsAfterDown = distinct.length;
  verdict.durationMs = after[after.length - 1].t - down.t;
  if (
    distinct.length === 1 &&
    after.length >= COLLAPSE_MIN_SAMPLES &&
    verdict.screenSpanPx >= COLLAPSE_MIN_SPAN_PX &&
    verdict.durationMs >= COLLAPSE_MIN_DURATION_MS
  ) {
    verdict.shape = samePoint(distinct[0], down.point)
      ? "whole-stroke-frozen"
      : "line-to-fixed-point";
  }
  return verdict;
}

/** The fields of a panel's projection this needs. ProjectionParameters extends
 *  RenderViewport, so a slice panel's projectionParameters.value is one. */
export interface PanelProjection {
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  visibleLeftFraction: number;
  visibleTopFraction: number;
  viewProjectionMat: mat4;
}

/**
 * Where a slice panel draws a position, in the same pixel frame as the
 * panel's own mouseX / mouseY (CSS pixels from the panel's content corner).
 *
 * This runs the viewer's own mouse-to-position conversion backwards:
 * rendered_data_panel.ts issuePickRequestInternal turns mouseX / mouseY into
 * a GL window pixel, and sliceview/panel.ts completePickRequest (setPosition)
 * turns that into a position through invViewProjectionMat, writing the display
 * dimensions and copying every other dimension from the navigation position.
 * Going forward from the position instead of backward from the pointer is what
 * makes the answer a distance in pixels, which is the unit a person can judge.
 *
 * Returns null when the projection cannot place it (non-finite result).
 */
export function panelPixelOfPosition(
  position: ArrayLike<number>,
  displayDimensionIndices: ArrayLike<number>,
  displayRank: number,
  projection: PanelProjection,
): { x: number; y: number } | null {
  const v = vec3.create();
  for (let i = 0; i < displayRank && i < 3; ++i) {
    v[i] = position[displayDimensionIndices[i]];
  }
  vec3.transformMat4(v, v, projection.viewProjectionMat);
  const glX = ((v[0] + 1) / 2) * projection.width;
  const glY = ((v[1] + 1) / 2) * projection.height;
  const x = glX + projection.visibleLeftFraction * projection.logicalWidth;
  const y =
    projection.height -
    glY +
    projection.visibleTopFraction * projection.logicalHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// ---------------------------------------------------------------------------
// The live half: what the viewer looked like when a stroke went wrong.
//
// Everything below reads Neuroglancer objects through `any`, because the
// fields it wants (a panel's mouseX, whether it was disposed) are internals no
// public type exposes. Every read is guarded: a probe that throws inside the
// mousedown handler would take the drawing tool down with it.

/** How far pen-down may sit from the pointer before it counts as wrong.
 *  mouseState.position snaps to the nearest picked object within pickRadius
 *  (5 px, rendered_data_panel.ts) in each axis, so up to about 7 px is normal. */
export const PEN_DOWN_TOLERANCE_PX = 12;

/** Records printed per page load. A stuck state prints one per stroke, and the
 *  first few carry everything the rest would. */
export const MAX_RECORDS = 25;

const SAMPLE_CAP = 5000;

export interface PanelReport {
  index: number;
  kind: "slice" | "3d" | "other";
  underPointer: boolean;
  connected: boolean | null;
  disposed: boolean;
  /** The panel's own idea of where the mouse is; -1 means "not over me". */
  mouseX: number | null;
  mouseY: number | null;
  pickPending: boolean | null;
  sliceValid: boolean | null;
  /** Whether the browser thinks the pointer is over this panel's element. A
   *  panel with mouseX >= 0 that is NOT hovered is holding a stale position,
   *  and it re-issues a pick at that pixel every time it draws. */
  hovered: boolean | null;
  /** Frames since this panel last drew successfully; a panel only issues a
   *  pick for a mousemove when this is 0 (rendered_data_panel.ts
   *  updateMousePosition). */
  framesSinceLastDraw: number | null;
  /** This panel's pick was the last write to viewer.mouseState.position. */
  lastWriter: boolean;
  /** Picks this panel completed during the stroke. */
  writesDuringStroke: number;
}

function guard<T>(read: () => T, fallback: T): T {
  try {
    const v = read();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function round(v: number, digits = 2) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function describePanels(
  viewer: any,
  target: EventTarget | null,
  writes: { last: unknown; during: Map<unknown, number> } = {
    last: undefined,
    during: new Map(),
  },
): PanelReport[] {
  const out: PanelReport[] = [];
  const panels = guard(
    () => Array.from(viewer.display.panels as Iterable<any>),
    [],
  );
  panels.forEach((panel: any, index: number) => {
    const element = guard(
      () => panel.element as HTMLElement | undefined,
      undefined,
    );
    out.push({
      index,
      kind: guard(
        () => (panel.sliceView ? "slice" : panel.pickRequests ? "3d" : "other"),
        "other",
      ),
      underPointer: element !== undefined && element === target,
      connected: guard(() => (element ? element.isConnected : null), null),
      disposed: guard(() => panel.wasDisposed === true, false),
      mouseX: guard(
        () => (typeof panel.mouseX === "number" ? round(panel.mouseX) : null),
        null,
      ),
      mouseY: guard(
        () => (typeof panel.mouseY === "number" ? round(panel.mouseY) : null),
        null,
      ),
      pickPending: guard(
        () =>
          typeof panel.pickRequestPending === "boolean"
            ? panel.pickRequestPending
            : null,
        null,
      ),
      sliceValid: guard(
        () => (panel.sliceView ? panel.sliceView.valid === true : null),
        null,
      ),
      hovered: guard(() => (element ? element.matches(":hover") : null), null),
      framesSinceLastDraw: guard(() => {
        const drawn = panel.pickingData[1].frameNumber;
        return typeof drawn === "number" && drawn >= 0
          ? viewer.display.frameNumber - drawn
          : null;
      }, null),
      lastWriter: writes.last === panel,
      writesDuringStroke: writes.during.get(panel) ?? 0,
    });
  });
  return out;
}

interface StrokeInProgress {
  mode: string;
  startedAt: number;
  wall: string;
  target: EventTarget | null;
  samples: ProbeSample[];
  rejected: { offPanel: number; outsideData: number };
  mouseStateUpdatesAtStart: number;
  framesAtStart: number;
  writers: Map<unknown, number>;
  down: Record<string, unknown>;
  penDownOffsetPx: number | null;
  penDownOnLivePanel: boolean;
}

/**
 * Watches every prompt stroke and prints a record when one comes out wrong.
 *
 * One per viewer, created with the drawing handler. The handler calls
 * begin() when it accepts a mousedown, sample() for each mousemove it records,
 * reject() for each one it throws away, and end() when the stroke is finished.
 */
export class PromptProbe {
  private readonly bootAt: number;
  private panelSet = new Set<unknown>();
  private panelSetChanges = 0;
  private lastPanelSetChangeAt: number | null = null;
  private layersChanges = 0;
  private lastLayersChangeAt: number | null = null;
  private coordinateSpaceChanges = 0;
  private lastCoordinateSpaceChangeAt: number | null = null;
  /** mouseState.changed dispatches. Every completed pick dispatches one
   *  (setActive(true) always does); losing the mouse dispatches one more. */
  private mouseStateUpdates = 0;
  /** display.changed dispatches: one per drawn frame. */
  private frames = 0;
  private stroke: StrokeInProgress | null = null;
  /** The panel whose completePickRequest ran last, i.e. whose value
   *  mouseState.position holds (unless a snap moved it within that call). */
  private lastWriter: unknown = undefined;
  private readonly instrumented = new WeakSet<object>();
  private printed = 0;
  private suppressed = 0;
  private baselinePrinted = false;

  constructor(
    private readonly viewer: any,
    private readonly build: { commit: string; bundle: string },
    private readonly now: () => number = () => performance.now(),
    private readonly emit: (line: string) => void = (line) =>
      // A finding is a warning; the one baseline per page load is not.
      line.startsWith("[prompt-probe] baseline ")
        ? console.log(line)
        : console.warn(line),
    /** State only the drawing handler can see, added to every record. */
    private readonly handlerState: () => unknown = () => null,
  ) {
    this.bootAt = now();
    this.notePanelSet(false);
    guard(
      () =>
        viewer.display.changed.add(() => {
          ++this.frames;
          this.notePanelSet(true);
        }),
      undefined,
    );
    guard(
      () =>
        viewer.mouseState.changed.add(() => {
          ++this.mouseStateUpdates;
        }),
      undefined,
    );
    guard(
      () =>
        viewer.layerManager.layersChanged.add(() => {
          ++this.layersChanges;
          this.lastLayersChangeAt = this.now();
        }),
      undefined,
    );
    guard(
      () =>
        viewer.coordinateSpace.changed.add(() => {
          ++this.coordinateSpaceChanges;
          this.lastCoordinateSpaceChangeAt = this.now();
        }),
      undefined,
    );
  }

  /** Panels are rebuilt, not restyled: on a layout change
   *  (data_panel_layout.ts updateLayout -> disposeLayout), and on EVERY state
   *  push from the Python server, which the viewer applies as reset() then
   *  restoreState() (python_integration/api.ts setServerState), recreating all
   *  layers and all panels. SAVAII's lock, Commit, clear-strokes, unlock and
   *  sidebar layer changes each push. So a change in the set of panel objects
   *  dates the last rebuild. Called every frame; the set is a handful. */
  private notePanelSet(countIt: boolean) {
    const current = guard(
      () => new Set<unknown>(viewerPanels(this.viewer)),
      new Set<unknown>(),
    );
    let same = current.size === this.panelSet.size;
    if (same) {
      for (const p of current) {
        if (!this.panelSet.has(p)) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    this.panelSet = current;
    for (const p of current) this.instrument(p);
    if (countIt) {
      ++this.panelSetChanges;
      this.lastPanelSetChangeAt = this.now();
    }
  }

  /**
   * Note which panel's pick writes the shared mouse state. Wraps the panel's
   * own completePickRequest and calls straight through, so the pick itself is
   * untouched; the wrapper only records who ran. Any panel whose pick
   * completes writes viewer.mouseState (sliceview/panel.ts completePickRequest,
   * perspective_view/panel.ts likewise), and which panel that was is the one
   * thing the other fields cannot tell apart.
   */
  private instrument(panel: any) {
    if (panel === null || typeof panel !== "object") return;
    if (this.instrumented.has(panel)) return;
    this.instrumented.add(panel);
    const original = guard(() => panel.completePickRequest, undefined);
    if (typeof original !== "function") return;
    const probe = this;
    panel.completePickRequest = function (this: unknown, ...args: unknown[]) {
      probe.lastWriter = panel;
      const writers = probe.stroke?.writers;
      if (writers) writers.set(panel, (writers.get(panel) ?? 0) + 1);
      return original.apply(this, args);
    };
  }

  begin(
    mode: string | null,
    e: MouseEvent,
    recorded: ProbePoint,
    screen: { x: number; y: number },
  ) {
    try {
      if (this.stroke !== null) {
        // The previous stroke never reached end(): its mouseup was lost, and
        // its listeners may still be attached.
        this.finish("stroke-never-ended");
      }
      const now = this.now();
      const down = this.describeDown(e, recorded);
      this.stroke = {
        mode: String(mode),
        startedAt: now,
        wall: new Date().toISOString(),
        target: e.target,
        samples: [
          {
            screenX: screen.x,
            screenY: screen.y,
            point: { ...recorded },
            t: now,
          },
        ],
        rejected: { offPanel: 0, outsideData: 0 },
        mouseStateUpdatesAtStart: this.mouseStateUpdates,
        framesAtStart: this.frames,
        writers: new Map(),
        down: down.fields,
        penDownOffsetPx: down.offsetPx,
        penDownOnLivePanel: down.onLivePanel,
      };
    } catch (err) {
      this.stroke = null;
      console.warn("[prompt-probe] begin failed:", err);
    }
  }

  sample(screen: { x: number; y: number }, recorded: ProbePoint) {
    const { stroke } = this;
    if (stroke === null || stroke.samples.length >= SAMPLE_CAP) return;
    stroke.samples.push({
      screenX: screen.x,
      screenY: screen.y,
      point: { ...recorded },
      t: this.now(),
    });
  }

  reject(reason: "offPanel" | "outsideData") {
    if (this.stroke !== null) ++this.stroke.rejected[reason];
  }

  end() {
    try {
      if (this.stroke === null) return;
      const { stroke } = this;
      const verdict = collapseVerdict(stroke.samples);
      let finding: string | null = verdict.shape;
      if (finding === null && !stroke.penDownOnLivePanel)
        finding = "pen-down-not-on-a-live-panel";
      if (
        finding === null &&
        stroke.penDownOffsetPx !== null &&
        stroke.penDownOffsetPx > PEN_DOWN_TOLERANCE_PX
      ) {
        finding = "pen-down-away-from-pointer";
      }
      if (finding === null && !this.baselinePrinted) finding = "baseline";
      if (finding === null) {
        this.stroke = null;
        return;
      }
      this.finish(finding, verdict);
    } catch (err) {
      this.stroke = null;
      console.warn("[prompt-probe] end failed:", err);
    }
  }

  private finish(
    finding: string,
    verdict: CollapseVerdict = collapseVerdict(this.stroke!.samples),
  ) {
    const stroke = this.stroke!;
    this.stroke = null;
    if (finding === "baseline") this.baselinePrinted = true;
    if (this.printed >= MAX_RECORDS) {
      ++this.suppressed;
      return;
    }
    ++this.printed;
    const now = this.now();
    const since = (t: number | null) =>
      t === null ? null : Math.round(now - t);
    const { samples } = stroke;
    const brief = (s: ProbeSample) => ({
      screen: [round(s.screenX, 1), round(s.screenY, 1)],
      point: [round(s.point.x), round(s.point.y), round(s.point.z)],
      ms: Math.round(s.t - stroke.startedAt),
    });
    const record = {
      probe: "prompt-probe/1",
      finding,
      mode: stroke.mode,
      wallClock: stroke.wall,
      msSincePageLoad: Math.round(stroke.startedAt - this.bootAt),
      build: this.build,
      down: stroke.down,
      // The same fields when the stroke finished: for a collapsed stroke this
      // is the state that produced the fixed value.
      mouseStateAtEnd: mouseStateSnapshot(this.viewer),
      penDownOffsetPx:
        stroke.penDownOffsetPx === null
          ? null
          : round(stroke.penDownOffsetPx, 1),
      stroke: {
        ...verdict,
        screenSpanPx: round(verdict.screenSpanPx, 1),
        durationMs: Math.round(verdict.durationMs),
        rejected: stroke.rejected,
        firstSamples: samples.slice(0, 4).map(brief),
        lastSamples: samples.length > 4 ? samples.slice(-3).map(brief) : [],
      },
      duringStroke: {
        mouseStateUpdates:
          this.mouseStateUpdates - stroke.mouseStateUpdatesAtStart,
        framesDrawn: this.frames - stroke.framesAtStart,
      },
      panels: describePanels(this.viewer, stroke.target, {
        last: this.lastWriter,
        during: stroke.writers,
      }),
      lastWriterIsLivePanel: this.panelSet.has(this.lastWriter),
      layout: guard(
        () => JSON.stringify(this.viewer.layout.toJSON()).slice(0, 200),
        null,
      ),
      handler: guard(() => this.handlerState(), null),
      msSince: {
        panelSetChange: since(this.lastPanelSetChangeAt),
        layersChanged: since(this.lastLayersChangeAt),
        coordinateSpaceChanged: since(this.lastCoordinateSpaceChangeAt),
      },
      countsSincePageLoad: {
        panelSetChanges: this.panelSetChanges,
        layersChanged: this.layersChanges,
        coordinateSpaceChanges: this.coordinateSpaceChanges,
        recordsSuppressed: this.suppressed,
      },
    };
    this.emit(`[prompt-probe] ${finding} ${JSON.stringify(record)}`);
    if (this.printed === MAX_RECORDS) {
      this.emit(
        `[prompt-probe] reached ${MAX_RECORDS} records; further ones are counted, not printed`,
      );
    }
  }

  private describeDown(e: MouseEvent, recorded: ProbePoint) {
    const viewer = this.viewer;
    const target = e.target;
    const panel = guard(
      () => viewerPanels(viewer).find((p: any) => p?.element === target),
      undefined,
    );
    const element: HTMLElement | undefined = guard(
      () => panel?.element,
      undefined,
    );
    const mouseState = guard(() => viewer.mouseState, undefined);
    let panelPixel: { x: number; y: number } | null = null;
    let recordedPixel: { x: number; y: number } | null = null;
    let offsetPx: number | null = null;
    if (panel && element && panel.sliceView) {
      panelPixel = guard(() => {
        const r = element.getBoundingClientRect();
        return {
          x: e.clientX - (r.left + element.clientLeft),
          y: e.clientY - (r.top + element.clientTop),
        };
      }, null);
      recordedPixel = guard(() => {
        const dd = panel.navigationState.pose.displayDimensions.value;
        return panelPixelOfPosition(
          mouseState.position,
          dd.displayDimensionIndices,
          dd.displayRank,
          panel.sliceView.projectionParameters.value,
        );
      }, null);
      if (panelPixel && recordedPixel) {
        offsetPx = Math.hypot(
          panelPixel.x - recordedPixel.x,
          panelPixel.y - recordedPixel.y,
        );
      }
    }
    const onLivePanel =
      panel !== undefined &&
      guard(() => panel.wasDisposed !== true, false) &&
      guard(() => element!.isConnected, false);
    const fields = {
      recorded: [round(recorded.x), round(recorded.y), round(recorded.z)],
      pointerOnPanel: panelPixel && [
        round(panelPixel.x, 1),
        round(panelPixel.y, 1),
      ],
      recordedOnPanel: recordedPixel && [
        round(recordedPixel.x, 1),
        round(recordedPixel.y, 1),
      ],
      panelUnderPointer:
        panel === undefined ? null : viewerPanels(viewer).indexOf(panel),
      panelMouse: panel
        ? [
            guard(() => round(panel.mouseX), null),
            guard(() => round(panel.mouseY), null),
          ]
        : null,
      mouseState: {
        ...mouseStateSnapshot(viewer),
        eventPageXY: [round(e.pageX, 1), round(e.pageY, 1)],
      },
    };
    return { fields, offsetPx, onLivePanel };
  }
}

function viewerPanels(viewer: any): any[] {
  return Array.from(viewer.display.panels as Iterable<any>);
}

/** Name of the layer that owns a render layer, for a picked object. */
function layerNameOf(viewer: any, renderLayer: unknown): string | null {
  if (!renderLayer) return null;
  for (const managed of guard(
    () => Array.from(viewer.layerManager.managedLayers as Iterable<any>),
    [],
  )) {
    const owns = guard(
      () => (managed.layer.renderLayers as unknown[]).includes(renderLayer),
      false,
    );
    if (owns) return guard(() => String(managed.name), null);
  }
  return "<not in any layer>";
}

/**
 * What viewer.mouseState holds right now.
 *
 * `position` is what a prompt records; `unsnappedPosition` is the same pick
 * before it was pulled onto a nearby object (sliceview/panel.ts
 * completePickRequest writes both; an annotation layer's updateMouseState
 * then snaps `position` onto the annotation it picked). The two differing,
 * with a picked annotation named, means the recorded point came from snapping.
 */
function mouseStateSnapshot(viewer: any) {
  const ms = guard(() => viewer.mouseState, undefined);
  const arr = (read: () => ArrayLike<number>) =>
    guard(() => Array.from(read()).map((v) => round(v)), [] as number[]);
  return {
    active: guard(() => ms.active === true, null),
    position: arr(() => ms.position),
    unsnappedPosition: arr(() => ms.unsnappedPosition),
    names: guard(
      () => Array.from(viewer.coordinateSpace.value.names as string[]),
      [] as string[],
    ),
    sameCoordinateSpaceObject: guard(
      () => ms.coordinateSpace === viewer.coordinateSpace.value,
      null,
    ),
    // After a state push from the Python server the space is rebuilt from
    // JSON and is invalid, with infinite bounds, until a layer binds it; no
    // slice panel picks meanwhile (sliceview/panel.ts drawWithPicking).
    coordinateSpaceValid: guard(
      () => viewer.coordinateSpace.value.valid === true,
      null,
    ),
    bounds: guard(() => {
      const b = viewer.coordinateSpace.value.bounds;
      return [
        Array.from(b.lowerBounds as ArrayLike<number>).map((v) => round(v)),
        Array.from(b.upperBounds as ArrayLike<number>).map((v) => round(v)),
      ];
    }, null),
    pickedLayer: guard(() => layerNameOf(viewer, ms.pickedRenderLayer), null),
    pickedAnnotationId: guard(
      () =>
        ms.pickedAnnotationId === undefined
          ? null
          : String(ms.pickedAnnotationId),
      null,
    ),
    // Set by the panel NG last saw the mouse over (handleMouseMove), so a gap
    // from the event's own page position says NG has stopped following it.
    lastPageXY: [
      guard(() => round(ms.pageX, 1), null),
      guard(() => round(ms.pageY, 1), null),
    ],
  };
}
