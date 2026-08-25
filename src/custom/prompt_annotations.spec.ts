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

import { describe, expect, it, vi } from "vitest";

import { AnnotationType } from "#src/annotation/index.js";
import {
  makeAnnotationPoint,
  promptAnnotations,
  promptFromPanel,
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

  it("says so when it drops a type it does not know", () => {
    // The caller skips whatever this returns null for, so an unrecognised type
    // would otherwise vanish between two versions with nothing said anywhere.
    // That is not hypothetical: a restore silently lost every box for weeks
    // because the handler skipped them without a word.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(promptFromPanel({ type: "sphere", data: {} })).toBe(null);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain("sphere");

      // Once per type, not once per prompt: a restore replays the whole list.
      const before = warn.mock.calls.length;
      promptFromPanel({ type: "sphere", data: {} });
      promptFromPanel({ type: "sphere", data: {} });
      expect(warn.mock.calls.length).toBe(before);
    } finally {
      warn.mockRestore();
    }
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
