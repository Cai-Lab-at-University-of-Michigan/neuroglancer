/**
 * Prompt shapes, and how each one becomes a Neuroglancer annotation.
 *
 * Split out of drawing_tool_handler so the coordinate work can be checked
 * without a viewer: everything here is a pure function of a prompt and the
 * viewer's coordinate space.
 *
 * The reason any of it exists: a finished prompt used to be left painted on the
 * 2D overlay canvas, which is drawn in screen pixels and never repainted. A box
 * or a scribble therefore stayed exactly where it had been drawn on the SCREEN.
 * It did not move with a pan, did not scale with a zoom, and stayed visible on
 * every Z slice when it belongs to the one slice it was drawn on. Points did not
 * have the problem because they were already annotations.
 */

import { AnnotationType, makeAnnotationId } from "#src/annotation/index.js";

export interface StrokePoint {
  x: number;
  y: number;
  z: number;
}

export interface PromptPoint {
  mode: "point";
  point: StrokePoint;
  polarity: "positive" | "negative";
}

export interface PromptBBox {
  mode: "bbox";
  startPoint: StrokePoint;
  endPoint: StrokePoint;
  polarity: "positive" | "negative";
}

export interface PromptScribble {
  mode: "scribble";
  points: StrokePoint[];
  polarity: "positive" | "negative";
}

export interface PromptLasso {
  mode: "lasso";
  points: StrokePoint[];
  polarity: "positive" | "negative";
}

export type Prompt = PromptPoint | PromptBBox | PromptScribble | PromptLasso;

export function isValidPoint(p: StrokePoint): boolean {
  return isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
}

/**
 * Where the pointer is, as a stroke should record it.
 *
 * Reads `unsnappedPosition`, never `position`. A slice panel's pick writes
 * both (sliceview/panel.ts completePickRequest): `unsnappedPosition` is the
 * point under the cursor, and `position` is then moved onto the nearest
 * picked object within pickRadius, and onto the annotation itself when that
 * object is one (annotation/renderlayer.ts updateMouseState -> snapPosition),
 * in every dimension including Z. Earlier prompts are annotations, so a
 * stroke drawn near one was pulled onto it: a straight line came out bent,
 * partly on that prompt's slice, and those coordinates went to the model.
 * Neuroglancer's own annotation tools place points from `unsnappedPosition`
 * for the same reason (ui/annotations.ts
 * getMousePositionInAnnotationCoordinates).
 */
export function pointFromMouseState(
  mouseState: any,
  coordinateSpace: any,
): StrokePoint {
  const p = mouseState?.unsnappedPosition;
  if (!p || p.length < 3) return { x: NaN, y: NaN, z: NaN };

  // Map position to x, y, z based on coordinate space dimension names
  const names = coordinateSpace?.names;
  if (names && names.length >= 3) {
    const ix = names.indexOf("x");
    const iy = names.indexOf("y");
    const iz = names.indexOf("z");
    if (ix >= 0 && iy >= 0 && iz >= 0) {
      return { x: p[ix], y: p[iy], z: p[iz] };
    }
  }
  // Fallback: assume position order is [x, y, z]
  return { x: p[0], y: p[1], z: p[2] };
}

/**
 * Whether the pointer is over the data, read from the same unsnapped value
 * and for the same reason: a snapped position can sit inside the data while
 * the cursor is outside it, or the other way round.
 *
 * Otherwise the check it replaces, unchanged: the first three stored
 * dimensions, each finite, lower bound inclusive, upper bound exclusive.
 */
export function mouseInDataBounds(
  mouseState: any,
  coordinateSpace: any,
): boolean {
  const pos = mouseState?.unsnappedPosition;
  const bounds = coordinateSpace?.bounds;
  if (!pos || pos.length < 3 || !bounds) return false;
  const { lowerBounds, upperBounds } = bounds;
  for (let i = 0; i < 3; i++) {
    if (!isFinite(pos[i])) return false;
    if (pos[i] < lowerBounds[i] || pos[i] >= upperBounds[i]) return false;
  }
  return true;
}

// [BUG-016] Build a Float32Array point in NG coordinate space order.
// The coordinate space is not always x, y, z in that order, and a point built
// positionally lands somewhere else entirely when it is not.
export function makeAnnotationPoint(
  viewer: any,
  pt: StrokePoint,
): Float32Array {
  const coordSpace = viewer?.coordinateSpace?.value;
  const names = coordSpace?.names;
  const ndim = names?.length ?? 3;
  const arr = new Float32Array(ndim);
  if (names) {
    const ix = names.indexOf("x"),
      iy = names.indexOf("y"),
      iz = names.indexOf("z");
    if (ix >= 0) arr[ix] = pt.x;
    if (iy >= 0) arr[iy] = pt.y;
    if (iz >= 0) arr[iz] = pt.z;
  } else {
    arr[0] = pt.x;
    arr[1] = pt.y;
    arr[2] = pt.z;
  }
  return arr;
}

/**
 * Turn a finished prompt into the annotations that stand for it.
 *
 * A box becomes a closed polyline rather than an axis-aligned bounding box. It
 * is drawn on a single slice, so its box would have zero thickness in Z, and
 * what a zero-thickness box does in a cross-section view is not something to
 * find out in production. A polyline is line segments lying in the slice plane,
 * which is the ordinary case for a line annotation.
 */
export function promptAnnotations(viewer: any, prompt: Prompt): any[] {
  const common = () => ({
    id: makeAnnotationId(),
    description: `${prompt.polarity} ${prompt.mode}`,
    properties: [],
    relatedSegments: [],
  });

  if (prompt.mode === "point") {
    if (!isValidPoint(prompt.point)) return [];
    return [
      {
        type: AnnotationType.POINT,
        point: makeAnnotationPoint(viewer, prompt.point),
        ...common(),
      },
    ];
  }

  if (prompt.mode === "bbox") {
    const { startPoint: a, endPoint: b } = prompt;
    if (!isValidPoint(a) || !isValidPoint(b)) return [];
    // The drag never changes slice, so both corners share a Z; taking it from
    // the first corner keeps the rectangle flat even if that ever stops
    // holding.
    const z = a.z;
    const corners: StrokePoint[] = [
      { x: a.x, y: a.y, z },
      { x: b.x, y: a.y, z },
      { x: b.x, y: b.y, z },
      { x: a.x, y: b.y, z },
      { x: a.x, y: a.y, z },
    ];
    return [
      {
        type: AnnotationType.POLYLINE,
        points: corners.map((p) => makeAnnotationPoint(viewer, p)),
        ...common(),
      },
    ];
  }

  if (prompt.mode !== "scribble" && prompt.mode !== "lasso") {
    // Every mode is spelled out above, so a new one added to the Prompt union
    // lands here and fails to compile. It used to fall into the path branch
    // below and be drawn as whatever `points` it happened to carry.
    return assertNeverPrompt(prompt);
  }

  // A one-point scribble has no segment to draw, and a polyline holding a
  // single point serializes zero instances.
  const points = prompt.points.filter(isValidPoint);
  if (points.length < 2) return [];
  return [
    {
      type: AnnotationType.POLYLINE,
      points: points.map((p) => makeAnnotationPoint(viewer, p)),
      ...common(),
    },
  ];
}

/**
 * The panel's own prompt shape, as it comes back on a prompt_restore. It keeps
 * the coordinates under `data`, arranged differently per mode, and the mode
 * under `type`. Anything unrecognised is dropped rather than guessed at.
 */
export function promptFromPanel(p: any): Prompt | null {
  if (!p?.data) return null;
  const polarity: "positive" | "negative" =
    p.polarity === "negative" ? "negative" : "positive";
  const point = (raw: any): StrokePoint => ({
    x: raw?.x ?? 0,
    y: raw?.y ?? 0,
    z: raw?.z ?? 0,
  });

  if (p.type === "point") {
    return { mode: "point", point: point(p.data), polarity };
  }
  if (p.type === "bbox") {
    if (!p.data.startPoint || !p.data.endPoint) return null;
    return {
      mode: "bbox",
      startPoint: point(p.data.startPoint),
      endPoint: point(p.data.endPoint),
      polarity,
    };
  }
  if (p.type === "scribble" || p.type === "lasso") {
    if (!Array.isArray(p.data.points)) return null;
    return { mode: p.type, points: p.data.points.map(point), polarity };
  }
  // Dropped, but not quietly. The caller skips whatever this returns null for,
  // so a prompt type the panel has learned to send and the viewer has not would
  // otherwise vanish between two versions with nothing said anywhere -- which
  // is how a restore silently lost every box for weeks.
  warnUnknownPromptType(p.type);
  return null;
}

/** Named types already warned about, so a restore of N prompts says it once. */
const warnedPromptTypes = new Set<string>();

function warnUnknownPromptType(type: unknown) {
  const name = typeof type === "string" ? type : String(type);
  if (warnedPromptTypes.has(name)) return;
  warnedPromptTypes.add(name);
  console.warn(
    `[prompt] ignoring a prompt of unknown type "${name}". This viewer bundle ` +
      "is older than the panel talking to it, or the type was misspelled; " +
      "either way the prompt is not drawn and not sent to the model.",
  );
}

function assertNeverPrompt(prompt: never): never[] {
  console.warn("[prompt] unhandled prompt mode:", prompt);
  return [];
}
