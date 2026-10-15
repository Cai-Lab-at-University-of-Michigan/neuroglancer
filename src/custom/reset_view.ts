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
 * "Reset view": put the camera back on the whole image. The slice views are
 * centered on the image, on its middle layer, unrotated, and zoomed so the
 * whole image fits in every slice panel on screen. The 3D view goes back to
 * its own default rotation and zoom.
 *
 * This only moves the camera. It changes the same state a user changes by
 * panning and zooming, nothing else.
 */

import { getBoundingBoxCenter } from "#src/coordinate_transform.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type { quat } from "#src/util/geom.js";
import { mat3 } from "#src/util/geom.js";
import type { Viewer } from "#src/viewer.js";

export interface SlicePanelFrame {
  // Panel orientation relative to the display axes.
  orientation: quat;
  // Panel size in screen pixels.
  width: number;
  height: number;
}

/**
 * The smallest cross-section zoom (canonical voxels per screen pixel) at which
 * an axis-aligned box with the given canonical extents fits inside every
 * panel. Panels with no size (hidden) are skipped; undefined when nothing can
 * be fitted.
 */
export function fitZoom(
  extents: ArrayLike<number>,
  panels: readonly SlicePanelFrame[],
): number | undefined {
  const rotation = mat3.create();
  let zoom = 0;
  for (const panel of panels) {
    if (!(panel.width > 0 && panel.height > 0)) continue;
    mat3.fromQuat(rotation, panel.orientation);
    // Columns 0 and 1 are the panel's screen x and y axes in display
    // coordinates; the box's shadow on each is the sum of its extents
    // weighted by how much of each axis points that way.
    let width = 0;
    let height = 0;
    for (let i = 0; i < 3; ++i) {
      width += Math.abs(rotation[i]) * extents[i];
      height += Math.abs(rotation[3 + i]) * extents[i];
    }
    zoom = Math.max(zoom, width / panel.width, height / panel.height);
  }
  return zoom > 0 && Number.isFinite(zoom) ? zoom : undefined;
}

export function resetView(viewer: Viewer): void {
  const coordinateSpace = viewer.coordinateSpace.value;
  if (!coordinateSpace.valid) return;
  const { bounds, rank } = coordinateSpace;

  // Same rule the viewer uses for its first position: the middle of the
  // bounds, on a voxel center, so Z lands on the middle layer.
  const center = new Float32Array(rank);
  getBoundingBoxCenter(center, bounds);
  for (let i = 0; i < rank; ++i) {
    center[i] = bounds.voxelCenterAtIntegerCoordinates[i]
      ? Math.round(center[i])
      : Math.floor(center[i]) + 0.5;
  }

  const navigationState = viewer.navigationState;
  // Reset the rotation first: each slice panel's orientation follows it, and
  // the zoom below is computed from those orientations.
  navigationState.pose.orientation.reset();
  navigationState.position.value = center;

  const { canonicalVoxelFactors, displayDimensionIndices } =
    navigationState.displayDimensionRenderInfo.value;
  const extents = [0, 1, 2].map((i) => {
    const dim = displayDimensionIndices[i];
    if (dim === -1) return 0;
    return (
      (bounds.upperBounds[dim] - bounds.lowerBounds[dim]) *
      canonicalVoxelFactors[i]
    );
  });
  const panels: SlicePanelFrame[] = [];
  for (const candidate of viewer.display.panels) {
    // Recognized by shape, as drawing_tool_handler does: importing the class
    // pulls WebGL into anything that imports this module. The 3D panel has
    // `sliceViews`, not `sliceView`.
    if (!("sliceView" in candidate)) continue;
    const panel = candidate as SliceViewPanel;
    panels.push({
      orientation: panel.navigationState.pose.orientation.orientation,
      width: panel.element.clientWidth,
      height: panel.element.clientHeight,
    });
  }
  const zoom = fitZoom(extents, panels);
  if (zoom !== undefined) navigationState.zoomFactor.value = zoom;

  viewer.perspectiveNavigationState.pose.orientation.reset();
  viewer.perspectiveNavigationState.zoomFactor.reset();
}
