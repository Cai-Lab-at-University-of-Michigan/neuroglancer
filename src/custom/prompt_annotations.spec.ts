/**
 * The coordinate work behind rendering prompts as annotations.
 *
 * Before this, everything except a point stayed painted on the 2D overlay
 * canvas: screen pixels, never repainted, so a box drawn on one slice was
 * still there on every other slice, did not move with a pan and did not scale
 * with a zoom. The fix hands each finished prompt to the annotation layer, and
 * what can go wrong there is the arithmetic -- a rectangle whose corners are in
 * the wrong order, a Z taken from the wrong end of the drag, a coordinate space
 * that is not stored x, y, z.
 */

import { describe, expect, it } from "vitest";

import { AnnotationType } from "#src/annotation/index.js";
import {
  isPromptOnSlice,
  makeAnnotationPoint,
  promptAnnotations,
  promptFromPanel,
  promptZ,
} from "#src/custom/prompt_annotations.js";

/** A viewer whose coordinate space is in the given dimension order. */
function viewerWithDims(...names: string[]) {
  return { coordinateSpace: { value: { names } } };
}

const XYZ = viewerWithDims("x", "y", "z");

describe("makeAnnotationPoint", () => {
  it("stores each value under its own dimension", () => {
    expect(Array.from(makeAnnotationPoint(XYZ, { x: 1, y: 2, z: 3 }))).toEqual([
      1, 2, 3,
    ]);
  });

  it("follows the coordinate space rather than assuming x, y, z", () => {
    // Nothing guarantees the order, and a point built positionally lands in a
    // different place entirely when it is not the assumed one.
    const zyx = viewerWithDims("z", "y", "x");
    expect(Array.from(makeAnnotationPoint(zyx, { x: 1, y: 2, z: 3 }))).toEqual([
      3, 2, 1,
    ]);
  });

  it("keeps the extra dimensions of a 4D space at zero", () => {
    const czyx = viewerWithDims("c", "z", "y", "x");
    expect(Array.from(makeAnnotationPoint(czyx, { x: 1, y: 2, z: 3 }))).toEqual(
      [0, 3, 2, 1],
    );
  });
});

describe("a box becomes a closed rectangle on the slice it was drawn on", () => {
  const bbox = {
    mode: "bbox" as const,
    startPoint: { x: 10, y: 20, z: 5 },
    endPoint: { x: 40, y: 60, z: 5 },
    polarity: "positive" as const,
  };

  it("is a polyline, not a zero-thickness bounding box", () => {
    // An axis-aligned bounding box drawn on one slice has no extent in Z, and
    // what a cross-section view does with that is not something to find out in
    // production.
    const [annotation] = promptAnnotations(XYZ, bbox);
    expect(annotation.type).toBe(AnnotationType.POLYLINE);
  });

  it("walks the four corners and closes back on the first", () => {
    const [annotation] = promptAnnotations(XYZ, bbox);
    expect(annotation.points.map((p: Float32Array) => Array.from(p))).toEqual([
      [10, 20, 5],
      [40, 20, 5],
      [40, 60, 5],
      [10, 60, 5],
      [10, 20, 5],
    ]);
  });

  it("keeps every corner on one slice even if the drag reports two", () => {
    // The drag cannot cross slices in practice, so a rectangle with corners on
    // two of them would be a bug somewhere upstream showing up as a shape that
    // is on neither slice.
    const [annotation] = promptAnnotations(XYZ, {
      ...bbox,
      endPoint: { x: 40, y: 60, z: 9 },
    });
    const zs = annotation.points.map((p: Float32Array) => p[2]);
    expect(new Set(zs)).toEqual(new Set([5]));
  });

  it("is dropped when a corner never landed on the data", () => {
    expect(
      promptAnnotations(XYZ, {
        ...bbox,
        endPoint: { x: Number.NaN, y: 60, z: 5 },
      }),
    ).toEqual([]);
  });
});

describe("a scribble or lasso becomes the path it traced", () => {
  const scribble = {
    mode: "scribble" as const,
    points: [
      { x: 1, y: 1, z: 2 },
      { x: 2, y: 3, z: 2 },
      { x: 5, y: 8, z: 2 },
    ],
    polarity: "negative" as const,
  };

  it("keeps the points in the order they were drawn", () => {
    const [annotation] = promptAnnotations(XYZ, scribble);
    expect(annotation.type).toBe(AnnotationType.POLYLINE);
    expect(annotation.points.map((p: Float32Array) => Array.from(p))).toEqual([
      [1, 1, 2],
      [2, 3, 2],
      [5, 8, 2],
    ]);
  });

  it("drops the samples taken off the data", () => {
    const [annotation] = promptAnnotations(XYZ, {
      ...scribble,
      points: [
        { x: 1, y: 1, z: 2 },
        { x: Number.NaN, y: Number.NaN, z: Number.NaN },
        { x: 5, y: 8, z: 2 },
      ],
    });
    expect(annotation.points).toHaveLength(2);
  });

  it("produces nothing from a path with no segment in it", () => {
    // A polyline holding a single point serializes zero line instances, so
    // this would be an annotation that exists and draws nothing.
    expect(
      promptAnnotations(XYZ, { ...scribble, points: [{ x: 1, y: 1, z: 2 }] }),
    ).toEqual([]);
    expect(promptAnnotations(XYZ, { ...scribble, points: [] })).toEqual([]);
  });

  it("says which polarity it belongs to", () => {
    const [annotation] = promptAnnotations(XYZ, scribble);
    expect(annotation.description).toBe("negative scribble");
  });
});

describe("promptFromPanel reads back every shape the panel sends", () => {
  // The panel keeps coordinates under `data`, arranged differently per mode.
  // Restoring used to accept only points, which quietly deleted every box and
  // scribble from the viewer's own list on a neuron switch or an undo.
  it("reads a point", () => {
    expect(
      promptFromPanel({
        type: "point",
        polarity: "positive",
        data: { x: 1, y: 2, z: 3 },
      }),
    ).toEqual({
      mode: "point",
      point: { x: 1, y: 2, z: 3 },
      polarity: "positive",
    });
  });

  it("reads a box", () => {
    expect(
      promptFromPanel({
        type: "bbox",
        polarity: "negative",
        data: {
          startPoint: { x: 1, y: 2, z: 3 },
          endPoint: { x: 4, y: 5, z: 3 },
        },
      }),
    ).toEqual({
      mode: "bbox",
      startPoint: { x: 1, y: 2, z: 3 },
      endPoint: { x: 4, y: 5, z: 3 },
      polarity: "negative",
    });
  });

  it("reads a scribble and a lasso", () => {
    for (const type of ["scribble", "lasso"] as const) {
      expect(
        promptFromPanel({
          type,
          polarity: "positive",
          data: { points: [{ x: 1, y: 1, z: 1 }] },
        }),
      ).toEqual({
        mode: type,
        points: [{ x: 1, y: 1, z: 1 }],
        polarity: "positive",
      });
    }
  });

  it("survives a round trip through the panel's own shape", () => {
    // What the panel stores is built from the viewer's prompt_complete, so the
    // two have to agree on the field names or the restore silently empties.
    const restored = promptFromPanel({
      type: "bbox",
      polarity: "positive",
      data: {
        startPoint: { x: 10, y: 20, z: 5 },
        endPoint: { x: 40, y: 60, z: 5 },
      },
    });
    const [annotation] = promptAnnotations(XYZ, restored!);
    expect(annotation.points).toHaveLength(5);
  });

  it("drops what it cannot read rather than guessing", () => {
    expect(promptFromPanel(null)).toBe(null);
    expect(promptFromPanel({ type: "point" })).toBe(null);
    expect(promptFromPanel({ type: "sphere", data: {} })).toBe(null);
    // A box missing a corner is not a box.
    expect(
      promptFromPanel({ type: "bbox", data: { startPoint: { x: 1 } } }),
    ).toBe(null);
    expect(promptFromPanel({ type: "scribble", data: { points: "no" } })).toBe(
      null,
    );
  });

  it("treats anything but an explicit negative as positive", () => {
    expect(promptFromPanel({ type: "point", data: {} })?.polarity).toBe(
      "positive",
    );
  });
});

describe("a prompt belongs to the slice it was drawn on", () => {
  // Neuroglancer will not do this for us: its cross-section fade is scaled to
  // the slice view's depth range, which is deep enough that scrolling away
  // barely dims anything, and its per-dimension clip is inert whenever Z is one
  // of the displayed dimensions -- which it is in any multi-panel layout. So a
  // box drawn on one slice stayed legible on all of them.
  const at = (z: number) => ({ x: 1, y: 1, z });

  const point = (z: number) => ({
    mode: "point" as const,
    point: at(z),
    polarity: "positive" as const,
  });
  const bbox = (zA: number, zB: number) => ({
    mode: "bbox" as const,
    startPoint: at(zA),
    endPoint: at(zB),
    polarity: "positive" as const,
  });
  const scribble = (...zs: number[]) => ({
    mode: "scribble" as const,
    points: zs.map(at),
    polarity: "positive" as const,
  });

  it("reads the slice off each shape", () => {
    expect(promptZ(point(7))).toBe(7);
    expect(promptZ(bbox(7, 7))).toBe(7);
    expect(promptZ(scribble(7, 7, 7))).toBe(7);
  });

  it("agrees with the corner the rectangle is actually flattened onto", () => {
    // promptAnnotations puts every corner on the FIRST corner's Z. If the
    // slice test read the other one, a box could be culled on the very slice
    // it is drawn on.
    const box = bbox(7, 9);
    const [annotation] = promptAnnotations(XYZ, box);
    const drawnZ = annotation.points[0][2];
    expect(promptZ(box)).toBe(drawnZ);
    expect(isPromptOnSlice(box, drawnZ)).toBe(true);
  });

  it("takes the slice from the first sample that landed on the data", () => {
    // A stray non-finite sample must not decide which slice the shape is on.
    expect(
      promptZ({
        mode: "scribble",
        points: [{ x: Number.NaN, y: Number.NaN, z: Number.NaN }, at(4), at(4)],
        polarity: "positive",
      }),
    ).toBe(4);
    expect(promptZ(bbox(Number.NaN, 9))).toBe(9);
  });

  it("has no slice when nothing landed on the data", () => {
    expect(promptZ(point(Number.NaN))).toBe(null);
    expect(promptZ(scribble())).toBe(null);
  });

  it("shows on its own slice and not on the next one", () => {
    expect(isPromptOnSlice(point(7), 7)).toBe(true);
    expect(isPromptOnSlice(point(7), 8)).toBe(false);
    expect(isPromptOnSlice(point(7), 6)).toBe(false);
    // The slice position is a float and so is the click, so the window has to
    // be a half voxel rather than an equality test.
    expect(isPromptOnSlice(point(7), 7.4)).toBe(true);
    expect(isPromptOnSlice(point(7), 7.6)).toBe(false);
  });

  it("is not shown when either side has no position", () => {
    expect(isPromptOnSlice(point(Number.NaN), 7)).toBe(false);
    expect(isPromptOnSlice(point(7), Number.NaN)).toBe(false);
  });

  it("keeps a whole scribble on one slice", () => {
    // The drag cannot cross slices, so the whole path shares the first
    // sample's Z; a per-point test would flicker the stroke in and out.
    expect(isPromptOnSlice(scribble(3, 3, 3), 3)).toBe(true);
    expect(isPromptOnSlice(scribble(3, 3, 3), 4)).toBe(false);
  });
});
