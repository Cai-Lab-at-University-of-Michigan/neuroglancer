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

import { fitZoom, resetView } from "#src/custom/reset_view.js";
import { quat } from "#src/util/geom.js";
import type { Viewer } from "#src/viewer.js";

// The orientations the named layouts give their panels (data_panel_layout.ts).
const XY = quat.create();
const XZ = quat.rotateX(quat.create(), quat.create(), Math.PI / 2);
const YZ = quat.rotateY(quat.create(), quat.create(), Math.PI / 2);

describe("fitZoom", () => {
  // A 1000 x 500 x 50 voxel image.
  const extents = [1000, 500, 50];

  it("fits the longer in-plane side of an XY panel", () => {
    expect(
      fitZoom(extents, [{ orientation: XY, width: 500, height: 500 }]),
    ).toBeCloseTo(2);
    expect(
      fitZoom(extents, [{ orientation: XY, width: 2000, height: 100 }]),
    ).toBeCloseTo(5);
  });

  it("uses Z for the vertical axis of an XZ panel", () => {
    expect(
      fitZoom(extents, [{ orientation: XZ, width: 500, height: 10 }]),
    ).toBeCloseTo(5);
  });

  it("uses Z for the horizontal axis of a YZ panel", () => {
    expect(
      fitZoom(extents, [{ orientation: YZ, width: 10, height: 1000 }]),
    ).toBeCloseTo(5);
  });

  it("takes the zoom that fits every panel", () => {
    const panels = [
      { orientation: XY, width: 500, height: 500 },
      { orientation: XZ, width: 500, height: 10 },
      { orientation: YZ, width: 100, height: 500 },
    ];
    expect(fitZoom(extents, panels)).toBeCloseTo(5);
  });

  it("skips panels with no size, and gives up when nothing has one", () => {
    expect(
      fitZoom(extents, [
        { orientation: XY, width: 0, height: 0 },
        { orientation: XY, width: 1000, height: 1000 },
      ]),
    ).toBeCloseTo(1);
    expect(
      fitZoom(extents, [{ orientation: XY, width: 0, height: 0 }]),
    ).toBeUndefined();
    expect(fitZoom(extents, [])).toBeUndefined();
    expect(
      fitZoom([0, 0, 0], [{ orientation: XY, width: 100, height: 100 }]),
    ).toBeUndefined();
  });
});

function fakePanel(orientation: quat, width: number, height: number) {
  const navigationState = { pose: { orientation: { orientation } } };
  return {
    sliceView: { navigationState },
    navigationState,
    element: { clientWidth: width, clientHeight: height },
  };
}

function fakeViewer(options: {
  upper: number[];
  canonicalVoxelFactors?: number[];
  panels: unknown[];
  valid?: boolean;
}) {
  const calls: string[] = [];
  const state = {
    position: new Float32Array([1, 2, 3]) as Float32Array,
    zoom: 7,
  };
  const viewer = {
    coordinateSpace: {
      value: {
        valid: options.valid ?? true,
        rank: 3,
        bounds: {
          lowerBounds: Float64Array.from([0, 0, 0]),
          upperBounds: Float64Array.from(options.upper),
          voxelCenterAtIntegerCoordinates: [false, false, false],
        },
      },
    },
    navigationState: {
      pose: { orientation: { reset: () => calls.push("slice orientation") } },
      position: {
        set value(v: Float32Array) {
          state.position = v;
        },
      },
      displayDimensionRenderInfo: {
        value: {
          canonicalVoxelFactors: Float64Array.from(
            options.canonicalVoxelFactors ?? [1, 1, 1],
          ),
          displayDimensionIndices: Int32Array.from([0, 1, 2]),
        },
      },
      zoomFactor: {
        set value(v: number) {
          state.zoom = v;
        },
      },
    },
    perspectiveNavigationState: {
      pose: { orientation: { reset: () => calls.push("3d orientation") } },
      zoomFactor: { reset: () => calls.push("3d zoom") },
    },
    display: { panels: new Set(options.panels) },
  };
  return { viewer: viewer as unknown as Viewer, state, calls };
}

describe("resetView", () => {
  it("centers on the image, on the middle layer, zoomed to fit", () => {
    const { viewer, state, calls } = fakeViewer({
      upper: [1000, 500, 51],
      panels: [fakePanel(XY, 500, 500), fakePanel(XZ, 500, 500)],
    });
    resetView(viewer);
    expect(Array.from(state.position)).toEqual([500.5, 250.5, 25.5]);
    expect(state.zoom).toBeCloseTo(2);
    expect(calls).toEqual(["slice orientation", "3d orientation", "3d zoom"]);
  });

  it("measures extents in canonical voxels", () => {
    // Z voxels four times as deep as they are wide.
    const { viewer, state } = fakeViewer({
      upper: [100, 100, 50],
      canonicalVoxelFactors: [1, 1, 4],
      panels: [fakePanel(XZ, 100, 100)],
    });
    resetView(viewer);
    expect(state.zoom).toBeCloseTo(2);
  });

  it("ignores panels that are not slice views", () => {
    const { viewer, state } = fakeViewer({
      upper: [1000, 1000, 10],
      // The 3D panel's shape: slice views, but not one of its own.
      panels: [
        { sliceViews: new Map(), element: { clientWidth: 1, clientHeight: 1 } },
      ],
    });
    resetView(viewer);
    expect(state.zoom).toBe(7);
  });

  it("does nothing before the coordinate space is known", () => {
    const { viewer, state, calls } = fakeViewer({
      upper: [1000, 500, 51],
      panels: [fakePanel(XY, 500, 500)],
      valid: false,
    });
    resetView(viewer);
    expect(Array.from(state.position)).toEqual([1, 2, 3]);
    expect(state.zoom).toBe(7);
    expect(calls).toEqual([]);
  });
});
