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

  it("never reads long, so the error is always 'survives too far'", () => {
    // The direction matters more than the size: the fade can only ever be too
    // generous, never cut something off early.
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
