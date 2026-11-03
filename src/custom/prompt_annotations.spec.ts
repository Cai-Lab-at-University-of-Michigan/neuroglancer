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
  findPromptSource,
  makeAnnotationPoint,
  mouseInDataBounds,
  pointFromMouseState,
  PromptLayerMirror,
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

describe("a box drawn in an XZ or YZ panel keeps its shape", () => {
  // Every box used to be built as if it lay in an XY plane: z from the first
  // corner, x paired with y. A box drawn in an XZ panel has one y and spans z,
  // so its corners collapsed onto one edge and what stayed on screen was a line.
  const corners = (prompt: Parameters<typeof promptAnnotations>[1]) =>
    promptAnnotations(XYZ, prompt)[0].points.map((p: Float32Array) =>
      Array.from(p),
    );
  const box = (
    startPoint: { x: number; y: number; z: number },
    endPoint: { x: number; y: number; z: number },
  ) => ({
    mode: "bbox" as const,
    startPoint,
    endPoint,
    polarity: "positive" as const,
  });

  it("in XY, spans x and y on the box's one z, as before", () => {
    expect(
      corners(box({ x: 10, y: 20, z: 5 }, { x: 40, y: 60, z: 5 })),
    ).toEqual([
      [10, 20, 5],
      [40, 20, 5],
      [40, 60, 5],
      [10, 60, 5],
      [10, 20, 5],
    ]);
  });

  it("in XZ, spans x and z on the box's one y", () => {
    expect(
      corners(box({ x: 10, y: 30, z: 4 }, { x: 40, y: 30, z: 16 })),
    ).toEqual([
      [10, 30, 4],
      [40, 30, 4],
      [40, 30, 16],
      [10, 30, 16],
      [10, 30, 4],
    ]);
  });

  it("in YZ, spans y and z on the box's one x", () => {
    expect(
      corners(box({ x: 25, y: 20, z: 16 }, { x: 25, y: 60, z: 4 })),
    ).toEqual([
      [25, 20, 16],
      [25, 60, 16],
      [25, 60, 4],
      [25, 20, 4],
      [25, 20, 16],
    ]);
  });

  it("stays on the first corner's y in XZ even if the drag reports two", () => {
    // The same guard the XY case has for z: the axis the box was drawn across
    // is the one it barely moves along, not necessarily one it never moves along.
    const ys = corners(
      box({ x: 10, y: 30, z: 4 }, { x: 40, y: 31, z: 16 }),
    ).map((p: number[]) => p[1]);
    expect(new Set(ys)).toEqual(new Set([30]));
  });

  it("comes back as a rectangle when the panel restores it", () => {
    // A restore (undo, switching objects) rebuilds every prompt from what the
    // panel kept, so it goes through the same arithmetic.
    const restored = promptFromPanel({
      type: "bbox",
      polarity: "positive",
      data: {
        startPoint: { x: 45.5, y: 48, z: 10.25 },
        endPoint: { x: 78.5, y: 48, z: 35 },
      },
    });
    const points = corners(restored!);
    expect(new Set(points.slice(0, 4).map(String)).size).toBe(4);
    expect(points[4]).toEqual(points[0]);
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

/**
 * A pick that landed near an earlier prompt, as recorded on rejoin
 * 2026-10-10: the cursor on slice 735.5, `position` pulled onto a line prompt
 * on slice 736.5 and a few voxels across. Stored z, y, x, which is not the
 * order the function returns, so a positional read is caught too. Values are
 * exact in float32.
 */
function snappedPick() {
  return {
    mouseState: {
      position: new Float32Array([736.5, 759.25, 608.75]),
      unsnappedPosition: new Float32Array([735.5, 758, 607.5]),
    },
    coordinateSpace: { names: ["z", "y", "x"] },
  };
}

describe("a stroke records where the pointer is, not where a pick snapped to", () => {
  it("takes the unsnapped position, Z included", () => {
    const { mouseState, coordinateSpace } = snappedPick();
    expect(pointFromMouseState(mouseState, coordinateSpace)).toEqual({
      x: 607.5,
      y: 758,
      z: 735.5,
    });
  });

  it("falls back to storage order when the space has no x, y, z names", () => {
    const mouseState = {
      position: new Float32Array([9, 9, 9]),
      unsnappedPosition: new Float32Array([1, 2, 3]),
    };
    expect(pointFromMouseState(mouseState, { names: ["a", "b", "c"] })).toEqual(
      { x: 1, y: 2, z: 3 },
    );
    expect(pointFromMouseState(mouseState, undefined)).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
  });

  it("gives NaN, not the snapped value, before any unsnapped pick exists", () => {
    // Neuroglancer starts unsnappedPosition as an empty array. A full
    // `position` beside it must not be used as a stand-in.
    const position = new Float32Array([1, 2, 3]);
    for (const unsnappedPosition of [
      new Float32Array(0),
      new Float32Array([1, 2]),
      undefined,
    ]) {
      const p = pointFromMouseState(
        { position, unsnappedPosition },
        { names: ["x", "y", "z"] },
      );
      expect([p.x, p.y, p.z].every(Number.isNaN)).toBe(true);
    }
    const none = pointFromMouseState(undefined, undefined);
    expect([none.x, none.y, none.z].every(Number.isNaN)).toBe(true);
  });
});

describe("the data-bounds gate asks about the pointer too", () => {
  const space = {
    bounds: { lowerBounds: [0, 0, 0], upperBounds: [1000, 1000, 800] },
  };

  it("says inside when only the snapped position is outside", () => {
    const mouseState = {
      position: new Float32Array([1200, 500, 400]),
      unsnappedPosition: new Float32Array([990, 500, 400]),
    };
    expect(mouseInDataBounds(mouseState, space)).toBe(true);
  });

  it("says outside when only the snapped position is inside", () => {
    const mouseState = {
      position: new Float32Array([990, 500, 400]),
      unsnappedPosition: new Float32Array([1200, 500, 400]),
    };
    expect(mouseInDataBounds(mouseState, space)).toBe(false);
  });

  it("keeps the old edges: lower bound in, upper bound out", () => {
    const at = (x: number) => ({
      unsnappedPosition: new Float32Array([x, 0, 0]),
    });
    expect(mouseInDataBounds(at(0), space)).toBe(true);
    expect(mouseInDataBounds(at(1000), space)).toBe(false);
  });

  it("says outside when there is nothing to judge", () => {
    const full = new Float32Array([5, 5, 5]);
    expect(
      mouseInDataBounds(
        { position: full, unsnappedPosition: new Float32Array(0) },
        space,
      ),
    ).toBe(false);
    expect(
      mouseInDataBounds(
        { unsnappedPosition: new Float32Array([NaN, 5, 5]) },
        space,
      ),
    ).toBe(false);
    expect(mouseInDataBounds({ unsnappedPosition: full }, {})).toBe(false);
  });
});

describe("findPromptSource", () => {
  const layer = (name: string, localAnnotations?: object) => ({
    name,
    layer: localAnnotations ? { localAnnotations } : {},
  });

  it("returns the source of the layer with that name", () => {
    const source = {};
    expect(
      findPromptSource(
        [layer("a"), layer("__seeds_pos", source)],
        "__seeds_pos",
      ),
    ).toBe(source);
  });

  it("follows a layer that was rebuilt, not the source it had before", () => {
    // The viewer rebuilds the prompt layers while a Commit is written. A source
    // remembered from before is then a dead object: clearing it leaves the
    // dots on screen. The lookup has to answer with what is in the manager now.
    const before = {};
    const after = {};
    const layers = [layer("__seeds_pos", before)];
    expect(findPromptSource(layers, "__seeds_pos")).toBe(before);

    layers[0] = layer("__seeds_pos", after);
    expect(findPromptSource(layers, "__seeds_pos")).toBe(after);
  });

  it("says null for a layer whose source is not ready, undefined for no layer", () => {
    expect(findPromptSource([layer("__seeds_pos")], "__seeds_pos")).toBeNull();
    expect(
      findPromptSource([layer("other", {})], "__seeds_pos"),
    ).toBeUndefined();
    expect(findPromptSource([], "__seeds_pos")).toBeUndefined();
  });
});

describe("PromptLayerMirror", () => {
  type Kind = "pos" | "neg";
  const point = (polarity: "positive" | "negative", x: number) => ({
    mode: "point" as const,
    point: { x, y: 0, z: 0 },
    polarity,
  });

  /** A source that records what it holds, standing in for a LocalAnnotationSource. */
  const makeSource = () => {
    const held: number[] = [];
    return {
      held,
      add: (a: { x: number }) => held.push(a.x),
      clear: () => {
        held.length = 0;
      },
    };
  };

  /** Layers by kind; a layer maps to its source, or to null while it is not ready. */
  function setup() {
    const layers = new Map<Kind, ReturnType<typeof makeSource> | null>();
    const created: Kind[] = [];
    const mirror = new PromptLayerMirror<Kind>({
      kinds: ["pos", "neg"],
      kindOf: (p) => (p.polarity === "positive" ? "pos" : "neg"),
      find: (kind) => (layers.has(kind) ? layers.get(kind) : undefined),
      create: (kind) => {
        created.push(kind);
        layers.set(kind, null);
      },
      annotationsOf: (p) => [{ x: (p as any).point.x }],
    });
    return { layers, created, mirror };
  }

  it("draws a prompt on its layer", () => {
    const { layers, mirror } = setup();
    const pos = makeSource();
    layers.set("pos", pos);
    expect(mirror.sync([point("positive", 1)])).toBe(true);
    expect(pos.held).toEqual([1]);
  });

  it("adds only the new prompts when the source is the same", () => {
    const { layers, mirror } = setup();
    const pos = makeSource();
    layers.set("pos", pos);
    mirror.sync([point("positive", 1)]);
    const clear = vi.spyOn(pos, "clear");
    mirror.sync([point("positive", 1), point("positive", 2)]);
    expect(pos.held).toEqual([1, 2]);
    expect(clear).not.toHaveBeenCalled();
  });

  it("draws every prompt again on the new source after the page rebuilt the layer", () => {
    // The page replaces the viewer's state, the layer comes back with an empty
    // source, and the prompts the panel and the next run use are not on it.
    const { layers, mirror } = setup();
    const prompts = [point("positive", 1), point("positive", 2)];
    layers.set("pos", makeSource());
    mirror.sync(prompts);
    const rebuilt = makeSource();
    layers.set("pos", rebuilt);
    expect(mirror.sync([...prompts, point("positive", 3)])).toBe(true);
    expect(rebuilt.held).toEqual([1, 2, 3]);
  });

  it("empties a rebuilt source that came back with stale contents", () => {
    const { layers, mirror } = setup();
    const prompts = [point("positive", 1)];
    layers.set("pos", makeSource());
    mirror.sync(prompts);
    const rebuilt = makeSource();
    rebuilt.held.push(99);
    layers.set("pos", rebuilt);
    mirror.sync(prompts);
    expect(rebuilt.held).toEqual([1]);
  });

  it("creates a layer the page removed, and says it is not done until the source is ready", () => {
    const { layers, created, mirror } = setup();
    const prompts = [point("positive", 1)];
    layers.set("pos", makeSource());
    mirror.sync(prompts);
    layers.delete("pos");
    expect(mirror.sync(prompts)).toBe(false);
    expect(created).toEqual(["pos"]);
    // Asked again while the new layer has no source yet: no second layer.
    expect(mirror.sync(prompts)).toBe(false);
    expect(created).toEqual(["pos"]);
    const fresh = makeSource();
    layers.set("pos", fresh);
    expect(mirror.sync(prompts)).toBe(true);
    expect(fresh.held).toEqual([1]);
  });

  it("waits for a layer that exists but has no source yet, even with nothing to draw", () => {
    const { layers, mirror } = setup();
    layers.set("pos", null);
    expect(mirror.sync([])).toBe(false);
  });

  it("empties a rebuilt source that comes back with the saved dots after the list was emptied", () => {
    // Save clears the list, but the page rebuilds the layer from a state that
    // still has the old dots; the layer is not ready when the clear arrives.
    const { layers, mirror } = setup();
    layers.set("pos", makeSource());
    mirror.sync([point("positive", 1)]);
    layers.set("pos", null);
    expect(mirror.sync([])).toBe(false);
    const back = makeSource();
    back.held.push(1, 2);
    layers.set("pos", back);
    expect(mirror.sync([])).toBe(true);
    expect(back.held).toEqual([]);
  });

  it("creates nothing for a kind that has no prompts", () => {
    const { created, mirror } = setup();
    expect(mirror.sync([])).toBe(true);
    expect(created).toEqual([]);
  });

  it("redraws everything after invalidate, so a restore that keeps the count still changes the layer", () => {
    const { layers, mirror } = setup();
    const pos = makeSource();
    layers.set("pos", pos);
    mirror.sync([point("positive", 1)]);
    mirror.invalidate();
    mirror.sync([point("positive", 7)]);
    expect(pos.held).toEqual([7]);
  });

  it("empties the layers when the list is emptied", () => {
    const { layers, mirror } = setup();
    const pos = makeSource();
    layers.set("pos", pos);
    mirror.sync([point("positive", 1)]);
    mirror.invalidate();
    mirror.sync([]);
    expect(pos.held).toEqual([]);
  });
});
