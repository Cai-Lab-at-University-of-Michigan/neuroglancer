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
 * ⚠️ READ THIS BEFORE TRUSTING A GREEN RUN.
 *
 * The slice fade lives in GLSL, inside a template string in
 * `AnnotationRenderHelper.getSliceFadeFactor` (annotation/type_handler.ts).
 * Node cannot execute it, so what follows is a MODEL of that expression, not
 * the expression. Editing the shader will not turn this file red.
 *
 * What it does buy is the part that is actually load-bearing and that nobody
 * can check by looking: the numbers. Every figure asserted here is quoted
 * somewhere a reader will believe it -- in slice_fade.ts's docstring, in a PR
 * body, in a review. If one of those is wrong, it is wrong here too and this
 * file says so.
 *
 * `fadeModel` below and the GLSL must be kept in step BY HAND. They are eleven
 * characters apart and both are in the repository, which is the best available
 * given the language boundary.
 */

import { describe, expect, it } from "vitest";
import {
  sliceFadeCurve,
  sliceFadeFactorGlsl,
  sliceFadeSlices,
} from "#src/annotation/slice_fade.js";

/**
 * Mirrors, character for character where it can:
 *   uSliceFadeSlices <= 0.0
 *     ? 1.0
 *     : pow(clamp(1.0 - abs(d) / uSliceFadeSlices, 0.0, 1.0), uSliceFadeCurve)
 */
function fadeModel(distance: number, slices: number, curve: number): number {
  if (slices <= 0) return 1;
  const t = Math.min(1, Math.max(0, 1 - Math.abs(distance) / slices));
  return t ** curve;
}

describe("the GLSL itself, pinned character for character", () => {
  // ⚠️ THIS IS THE ONE ASSERTION IN THE FILE THAT READS PRODUCTION CODE.
  // Everything else models the shader; this is the shader.
  //
  // It is a golden string on purpose, and the brittleness is the feature. Turn
  // the `<=` into a `<` and an opted-out layer divides by zero: abs(d)/0.0 is
  // +inf, 1.0 - inf is -inf, the clamp takes it to 0, and EVERY layer that has
  // not opted in vanishes -- point clouds included. That is finding F1 coming
  // back through one character, and before this test nothing would have caught
  // it. If you are here because a reformat broke it, re-read the string and
  // update it; if you are here because the logic changed, stop.
  it("emits exactly the expected expression", () => {
    expect(sliceFadeFactorGlsl("D")).toBe(
      "(uSliceFadeSlices <= 0.0 ? 1.0 : " +
        "pow(clamp(1.0 - abs(D) / uSliceFadeSlices, 0.0, 1.0), uSliceFadeCurve))",
    );
  });

  it("substitutes the caller's distance expression verbatim", () => {
    expect(
      sliceFadeFactorGlsl("getSliceSignedOutOfPlaneDistance(p)"),
    ).toContain("abs(getSliceSignedOutOfPlaneDistance(p))");
  });

  it("is parenthesised as a whole, so `x *= expr` is valid GLSL", () => {
    // line.ts and polyline.ts both use it as `ng_LineWidth *= ...`.
    const glsl = sliceFadeFactorGlsl("D");
    expect(glsl.startsWith("(")).toBe(true);
    expect(glsl.endsWith(")")).toBe(true);
  });

  it("guards the division rather than relying on the caller", () => {
    // The specific character. Named so a search for it lands here.
    expect(glslGuard(sliceFadeFactorGlsl("D"))).toBe("<=");
  });
});

/** The comparison operator in the opt-out guard, or "" if the guard is gone. */
function glslGuard(glsl: string): string {
  const m = glsl.match(/uSliceFadeSlices\s*(<=|<|>=|>|===?)\s*0\.0/);
  return m ? m[1] : "";
}

describe("the opt-out is the default, and it is exact", () => {
  // The whole of finding F1 in the 2026-08-25 review. A spot-detection point
  // cloud is an annotation layer, so a layer that has not opted in has to be
  // untouched -- not nearly untouched.
  it("returns exactly 1 at every distance when slices is 0", () => {
    for (const d of [0, 0.5, 1, 5, 50, 5000, -37]) {
      expect(fadeModel(d, 0, 1)).toBe(1);
    }
  });

  it("returns exactly 1 whatever curve an opted-out layer carries", () => {
    for (const curve of [0.01, 1, 2, 100]) {
      expect(fadeModel(9999, 0, curve)).toBe(1);
    }
  });
});

describe("how far it reaches", () => {
  it("is fully bright on its own slice", () => {
    expect(fadeModel(0, 5, 1)).toBe(1);
  });

  it("reaches exactly zero at `slices`, which is where the cull fires", () => {
    // point.ts culls in the vertex stage and line/polyline discard per
    // fragment, both on `<= 0.0`. This is the distance that makes it true.
    expect(fadeModel(5, 5, 1)).toBe(0);
    expect(fadeModel(5.0001, 5, 1)).toBe(0);
  });

  it("is symmetric above and below the slice", () => {
    expect(fadeModel(3, 5, 1)).toBe(fadeModel(-3, 5, 1));
  });

  it("puts the cut-off at `slices` for EVERY curve", () => {
    // The two knobs are meant to be independent: curve changes how fast it
    // dims, never how far it reaches. A reviewer checked this by hand on
    // 2026-08-25 (browser check 8); this is the same claim, pinned.
    for (const curve of [0.5, 1, 2, 8]) {
      expect(fadeModel(5, 5, curve)).toBe(0);
      expect(fadeModel(4.99, 5, curve)).toBeGreaterThan(0);
    }
  });
});

describe("the numbers quoted in slice_fade.ts's docstring", () => {
  it("dims a neighbouring slice to 80% at curve 1 and 64% at curve 2", () => {
    // "1 is linear, 2 dims a neighbour to 64% where linear leaves it at 80%."
    // Written as prose in slice_fade.ts, where nothing could contradict it.
    expect(fadeModel(1, 5, 1)).toBeCloseTo(0.8, 12);
    expect(fadeModel(1, 5, 2)).toBeCloseTo(0.64, 12);
  });

  it("falls linearly at curve 1", () => {
    for (const [d, expected] of [
      [1, 0.8],
      [2, 0.6],
      [3, 0.4],
      [4, 0.2],
    ] as const) {
      expect(fadeModel(d, 5, 1)).toBeCloseTo(expected, 12);
    }
  });
});

describe("the values the prompt layers are set to", () => {
  it("is 5 slices, linear", () => {
    // Changing these is a decision, not a tweak: 5 was measured against a
    // 1024x1024x1022 dataset and has roughly threefold headroom before
    // Neuroglancer's own cross-section slab clips instead. If this test fails,
    // the measurement notes in slice_fade.ts need redoing, not deleting.
    expect(sliceFadeSlices).toBe(5);
    expect(sliceFadeCurve).toBe(1);
  });
});

/**
 * The out-of-plane distance is measured along the view normal, in the layer's
 * own z units. Axis-aligned, that is exactly one per slice however anisotropic
 * the voxels are. Rotate the cross-section and it is not.
 *
 * `obliqueReading` is what one slice step reads as, for anisotropy `A` in z and
 * a cross-section rotated `theta` from axis-aligned:
 *
 *     reading = (sin^2 t + A cos^2 t) / sqrt(sin^2 t + A^2 cos^2 t)
 *
 * from `dot(subDelta, C a) / |C a|` with `C = diag(1, 1, A)` and the step taken
 * along the unit view normal `a` (translateVoxelsRelative applies the
 * orientation and no voxel factors, so a wheel click is one unit along `a`).
 */
function obliqueReading(anisotropy: number, thetaRadians: number): number {
  const s = Math.sin(thetaRadians) ** 2;
  const c = Math.cos(thetaRadians) ** 2;
  return (s + anisotropy * c) / Math.sqrt(s + anisotropy * anisotropy * c);
}

describe("an oblique cross-section under anisotropy reads short", () => {
  it("reads exactly one slice when axis-aligned, at any anisotropy", () => {
    for (const A of [1, 3, 8, 40]) {
      expect(obliqueReading(A, 0)).toBeCloseTo(1, 12);
      expect(obliqueReading(A, Math.PI / 2)).toBeCloseTo(1, 12);
    }
  });

  it("reads exactly one slice at any angle when the voxels are isotropic", () => {
    for (let deg = 0; deg <= 90; deg += 7.5) {
      expect(obliqueReading(1, (deg * Math.PI) / 180)).toBeCloseTo(1, 12);
    }
  });

  it("never reads long, as a property of the formula alone", () => {
    // Cauchy-Schwarz: a.Ca <= |a||Ca|. Taken by itself this says the fade can
    // only ever be too generous.
    //
    // ⚠️ Do not carry that conclusion over to what a user sees. The next
    // describe block is the reason, and it goes the other way.
    for (const A of [1, 2, 3, 8, 40]) {
      for (let deg = 0; deg <= 90; deg += 1) {
        expect(obliqueReading(A, (deg * Math.PI) / 180)).toBeLessThanOrEqual(
          1 + 1e-12,
        );
      }
    }
  });

  it("is worst at atan(sqrt(A)), where it reads 2*sqrt(A)/(1+A)", () => {
    // ⚠️ This is the number to quote, NOT the 0.8998 / "about 11%" figure in
    // the 2026-08-25 review. That was one sample rather than the bound; at
    // A = 3 the worst case is 0.866 (13.4% short) at 60 degrees, and at A = 8
    // it is 0.629 (37% short) at 70.5 degrees.
    for (const A of [2, 3, 8, 40]) {
      const worstAngle = Math.atan(Math.sqrt(A));
      const closedForm = (2 * Math.sqrt(A)) / (1 + A);
      expect(obliqueReading(A, worstAngle)).toBeCloseTo(closedForm, 12);

      // and it really is the minimum, not just a stationary point
      for (let deg = 0; deg <= 90; deg += 0.5) {
        expect(obliqueReading(A, (deg * Math.PI) / 180)).toBeGreaterThanOrEqual(
          closedForm - 1e-12,
        );
      }
    }
  });

  it("is not reachable from SAVAII's panel today", () => {
    // Recorded so the bound above is not mistaken for a live defect: the
    // embedded viewer offers no way to rotate a cross-section, which is why
    // browser check 13 could not be run on 2026-08-25. If a rotation control
    // ever appears, this is the arithmetic that says what to expect.
    expect(obliqueReading(3, Math.PI / 3)).toBeCloseTo(0.8660254, 6);
  });
});

/**
 * What a WHEEL CLICK reads, which is not what the formula above says.
 *
 * `translateVoxelsRelative` (navigation_state.ts) adds the rotated unit vector
 * onto the position and then puts every display coordinate through
 * `clampAndRoundCoordinateToVoxelCenter`, so the camera snaps back to a unit
 * lattice after every click. Whenever the view normal is not a chunk axis the
 * ideal step is therefore never taken, and the rounding error is larger than
 * the formula's own bias and does not share its sign.
 */
function clickReading(anisotropy: number, thetaRadians: number): number {
  const a = [0, -Math.sin(thetaRadians), Math.cos(thetaRadians)];
  const Ca = [0, a[1], anisotropy * a[2]];
  const n = Math.hypot(Ca[1], Ca[2]);
  const pos = [0, 0, 0];
  let prev = [...pos];
  for (let click = 0; click < 3; ++click) {
    // three clicks in, the lattice pattern has settled
    prev = [...pos];
    for (const i of [1, 2]) pos[i] = Math.round(pos[i] + a[i]);
  }
  const step = [0, pos[1] - prev[1], pos[2] - prev[2]];
  return Math.abs(step[1] * Ca[1] + step[2] * Ca[2]) / n;
}

describe("a wheel click is not the formula, and can cull EARLY", () => {
  it("is exactly one slice whenever the view normal is a chunk axis", () => {
    for (const A of [1, 3, 8, 40]) {
      expect(clickReading(A, 0)).toBeCloseTo(1, 12);
    }
  });

  it("matches the four cases quoted in slice_fade.ts", () => {
    expect(clickReading(8, (30 * Math.PI) / 180)).toBeCloseTo(0.99741, 5);
    expect(clickReading(3, (45 * Math.PI) / 180)).toBeCloseTo(1.26491, 5);
    expect(clickReading(3, (60 * Math.PI) / 180)).toBeCloseTo(1.36603, 5);
    expect(clickReading(1, (45 * Math.PI) / 180)).toBeCloseTo(Math.SQRT2, 12);
  });

  it("needs NO anisotropy at all: isotropic at 45 degrees culls early", () => {
    // ⚠️ The whole reason this block exists, and the part the 2026-08-25 review
    // did not have. With perfectly cubic voxels, rotating the cross-section 45
    // degrees rounds the ideal step (0, -0.7071, 0.7071) to (0, -1, 1), whose
    // length is sqrt(2). A click therefore covers 1.414 slices, five slices are
    // crossed in four clicks, and the annotation vanishes one click early.
    //
    // So "the error needs anisotropy plus rotation, and always errs toward
    // surviving too far" is wrong twice over: rotation alone is enough, and the
    // sign is the other way.
    const perClick = clickReading(1, (45 * Math.PI) / 180);
    expect(perClick).toBeCloseTo(Math.SQRT2, 12);
    expect(perClick).toBeGreaterThan(1);
    expect(Math.ceil(5 / perClick)).toBe(4);
  });

  it("is a bigger effect than the formula, and unrelated to it", () => {
    // At 8x/30 the rounding nearly cancels the formula's 10% shortfall out
    // (0.900 -> 0.997). At 3x/60, where the formula is at its worst (0.866),
    // the click reads 1.366 -- past 1, in the opposite direction. Knowing one
    // tells you nothing about the other.
    expect(clickReading(8, (30 * Math.PI) / 180)).toBeGreaterThan(
      obliqueReading(8, (30 * Math.PI) / 180),
    );
    expect(obliqueReading(3, Math.atan(Math.sqrt(3)))).toBeLessThan(1);
    expect(clickReading(3, Math.atan(Math.sqrt(3)))).toBeGreaterThan(1);
  });
});
