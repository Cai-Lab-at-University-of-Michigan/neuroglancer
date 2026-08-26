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
 * Reads the PRODUCTION default off the class that ships it.
 *
 * It lives in a browser test rather than beside slice_fade.spec.ts because
 * AnnotationDisplayState reaches webgl/shader.ts through its ShaderControlState,
 * which does not load in the node environment. That is the whole reason this is
 * a separate file, and it is worth one, because the sibling spec asserts what
 * "off" DOES and this asserts that "off" is what a layer actually gets.
 */

import { describe, expect, it } from "vitest";
import { AnnotationDisplayState } from "#src/annotation/annotation_layer_state.js";
import { sliceFadeCurve, sliceFadeSlices } from "#src/annotation/slice_fade.js";

describe("a fresh annotation layer has the fade OFF", () => {
  it("defaults sliceFadeSlices to 0, which the shader reads as no fade", () => {
    // ⚠️ This is finding F1. Every annotation layer starts here, and SAVAII's
    // spot-detection point clouds are annotation layers, so a default of
    // anything but 0 culls a researcher's whole point cloud five slices from
    // the current one. The sibling spec pins what 0 means; nothing there reads
    // this value, so nothing there would notice it changing.
    const displayState = new AnnotationDisplayState();
    expect(displayState.sliceFadeSlices.value).toBe(0);
  });

  it("is not accidentally set to the prompt layers' values", () => {
    const displayState = new AnnotationDisplayState();
    expect(displayState.sliceFadeSlices.value).not.toBe(sliceFadeSlices);
    // The curve default may legitimately equal the prompt curve; the reach is
    // the one that decides whether anything is culled.
    expect(sliceFadeCurve).toBe(1);
  });
});
