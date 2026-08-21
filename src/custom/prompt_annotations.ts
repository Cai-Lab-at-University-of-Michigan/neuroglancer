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
  return null;
}

/**
 * How far from a slice a prompt still counts as being on it.
 *
 * Half a voxel, so a prompt belongs to exactly one slice: the one it was drawn
 * on. The coordinates are floats read off the mouse, and the slice position is
 * a float too, so an equality test would match nothing.
 */
export const PROMPT_SLICE_TOLERANCE = 0.5;

/**
 * The slice a prompt was drawn on, or null if it never landed on the data.
 *
 * A drag cannot cross slices, so one coordinate speaks for the whole shape;
 * taking the first valid one keeps a stray non-finite sample from deciding it.
 */
export function promptZ(prompt: Prompt): number | null {
  if (prompt.mode === "point") {
    return isValidPoint(prompt.point) ? prompt.point.z : null;
  }
  if (prompt.mode === "bbox") {
    if (isValidPoint(prompt.startPoint)) return prompt.startPoint.z;
    return isValidPoint(prompt.endPoint) ? prompt.endPoint.z : null;
  }
  for (const point of prompt.points) {
    if (isValidPoint(point)) return point.z;
  }
  return null;
}

/**
 * Whether a prompt belongs to the slice currently on screen.
 *
 * A prompt is an input the model was given at one Z. Neuroglancer's own
 * cross-section fade is scaled to the slice view's depth range, which is deep
 * enough that scrolling away barely dims anything, and its per-dimension clip
 * is inert whenever Z is one of the displayed dimensions -- which it is in any
 * multi-panel layout. So a box drawn on one slice stayed legible on all of
 * them, which says the model was given something it was not.
 */
export function isPromptOnSlice(
  prompt: Prompt,
  sliceZ: number,
  tolerance: number = PROMPT_SLICE_TOLERANCE,
): boolean {
  const z = promptZ(prompt);
  if (z === null || !isFinite(sliceZ)) return false;
  return Math.abs(z - sliceZ) <= tolerance;
}
