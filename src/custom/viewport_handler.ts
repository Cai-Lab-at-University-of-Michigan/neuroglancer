/**
 * Viewport handler — listens for `viewport_request` postMessage from the
 * parent frame and answers with the current crosshair position +
 * coordinate-space bounds. Used by the parent's "Auto-contrast" buttons
 * to ask the CDN for a histogram localized around what the user is
 * looking at, instead of a global stratified sample.
 *
 * Protocol:
 *   parent → iframe: { type: "viewport_request", requestId }
 *   iframe → parent: { type: "viewport_response", requestId,
 *                      position: [x, y, z],
 *                      lowerBounds: [x0, y0, z0],
 *                      upperBounds: [x1, y1, z1],
 *                      voxelsPerPixel: number | null,
 *                      viewportHalfExtents: [hx, hy] | null }
 *
 * `voxelsPerPixel` = `physicalSizePerPixel / physicalSizePerVoxel`,
 * derived from the active panel's scale bar (the same numbers
 * drawing_tool_handler reports for the scale-bar overlay). It is the
 * downsample factor at which neuroglancer is currently rendering, so
 * the parent can forward it to the backend and the ECDF gets sampled
 * from the same mip the user is looking at instead of always picking
 * the finest mip that fits the budget.
 *
 * `viewportHalfExtents` is the half-width/half-height of the user's
 * actual viewport in mip-0 voxel units (= `panel.logicalSize *
 * voxelsPerPixel / 2`). The parent uses it as the bbox half-extent so
 * histogram sampling covers exactly what's on screen, regardless of
 * zoom. Falls back to a default if the iframe is unavailable.
 *
 * Position is the global voxel position (1X coordinates) at the
 * crosshair. lowerBounds/upperBounds are the dataset's full extent at
 * 1X. The parent uses position + a fixed half-extent to build a small
 * bbox; the backend then picks a mip such that the bbox fits its voxel
 * budget and computes the histogram on just those voxels.
 *
 * Why crosshair position instead of "exact visible viewport bounds":
 * computing the literal projected viewport in voxel coords requires
 * walking the projection matrix and the layer's local coordinate
 * transform. Crosshair is a 95%-correct proxy and ~50× simpler.
 */

import { ALLOWED_UNITS } from "#src/widget/scale_bar.js";

function convertLength(value: number, fromUnit: string, toUnit: string): number {
  const from = ALLOWED_UNITS.find((u) => u.unit === fromUnit);
  const to = ALLOWED_UNITS.find((u) => u.unit === toUnit);
  if (!from || !to) return value;
  return value * (from.lengthInNanometers / to.lengthInNanometers);
}

// Walks the active panel's scale bar (same source drawing_tool_handler uses
// for the scale-bar overlay) to find physical-units-per-screen-pixel. Returns
// µm/pixel, or null if no panel exposes it.
function getPhysicalSizePerPixel(viewer: any): number | null {
  if (!viewer?.display?.panels) return null;
  for (const panel of viewer.display.panels) {
    const scaleBars = panel?.scaleBars?.scaleBars;
    if (!scaleBars) continue;
    for (const scaleBar of scaleBars) {
      const dimensions = scaleBar?.dimensions;
      if (dimensions?.physicalSizePerPixel) {
        const baseUnit = dimensions.physicalBaseUnit ?? "m";
        return convertLength(dimensions.physicalSizePerPixel, baseUnit, "µm");
      }
    }
  }
  return null;
}

// Walks visible image layers to find the dataset's mip-0 physical voxel size
// (per-axis, in µm). Mirrors drawing_tool_handler's calculatePhysicalSizePerVoxel.
function getPhysicalSizePerVoxel(viewer: any): number[] | null {
  if (!viewer?.display?.panels) return null;
  const preferredTypes = ["image", null];
  for (const filterType of preferredTypes) {
    for (const panel of viewer.display.panels) {
      const sv = panel?.sliceView;
      if (!sv) continue;
      for (const managed of sv.visibleLayerList ?? []) {
        if (filterType && managed?.userLayer?.type !== filterType) continue;
        const info = sv.visibleLayers?.get?.(managed)?.displayDimensionRenderInfo;
        const scales = info?.displayDimensionScales;
        const units = info?.displayDimensionUnits;
        if (!scales || !units) continue;
        return Array.from(scales).map((v, i) =>
          convertLength(v as number, (Array.from(units)[i] as string) ?? "m", "µm"),
        );
      }
    }
  }
  return null;
}

// Downsample factor neuroglancer is currently rendering at: physical units
// per screen pixel divided by the smallest physical voxel size (the limiting
// axis, since neuroglancer picks mip by the finest dimension). 1 ≈ native;
// 2 ≈ first downsample; 4 ≈ second; etc.
function computeVoxelsPerPixel(viewer: any): number | null {
  const perPixel = getPhysicalSizePerPixel(viewer);
  const perVoxel = getPhysicalSizePerVoxel(viewer);
  if (perPixel === null || !perVoxel || perVoxel.length === 0) return null;
  const minVoxel = Math.min(...perVoxel.filter((v) => v > 0));
  if (!Number.isFinite(minVoxel) || minVoxel <= 0) return null;
  const ratio = perPixel / minVoxel;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

// Find the first slice panel and return its logical screen dimensions in
// pixels. We use slice panels (not the perspective panel) because their
// projection is axis-aligned, so screen width × voxelsPerPixel maps cleanly
// to mip-0 voxel extent along the visible axes.
function getActiveSlicePanelSize(viewer: any): [number, number] | null {
  const panels = viewer?.display?.panels;
  if (!panels) return null;
  for (const panel of panels) {
    const proj = panel?.sliceView?.projectionParameters?.value;
    if (!proj) continue;
    const w = Number(proj.logicalWidth);
    const h = Number(proj.logicalHeight);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return [w, h];
    }
  }
  return null;
}

// Half-extent (in mip-0 voxel units) of what's actually visible in the
// active slice panel. This replaces the parent's hard-coded fallback so
// the histogram is sampled over the user's real viewport, not a fixed-size
// patch around the crosshair.
function computeViewportHalfExtents(
  viewer: any,
  voxelsPerPixel: number | null,
): [number, number] | null {
  if (voxelsPerPixel === null) return null;
  const size = getActiveSlicePanelSize(viewer);
  if (!size) return null;
  const [w, h] = size;
  const hx = (w * voxelsPerPixel) / 2;
  const hy = (h * voxelsPerPixel) / 2;
  if (!Number.isFinite(hx) || !Number.isFinite(hy) || hx <= 0 || hy <= 0) {
    return null;
  }
  return [hx, hy];
}

export function initViewportHandler(viewer: any): void {
  window.addEventListener("message", (event) => {
    const { type, requestId } = event.data ?? {};
    if (type !== "viewport_request") return;
    if (!requestId) return;

    try {
      const positionRaw = viewer?.position?.value;
      const bounds = viewer?.coordinateSpace?.value?.bounds;
      const lower = bounds?.lowerBounds;
      const upper = bounds?.upperBounds;
      const dims = positionRaw?.length ?? 0;
      if (!positionRaw || dims < 3) {
        throw new Error("Viewer has no 3D position");
      }
      const position = [
        positionRaw[0],
        positionRaw[1],
        positionRaw[2],
      ];
      const lowerBounds = lower
        ? [Number(lower[0] ?? 0), Number(lower[1] ?? 0), Number(lower[2] ?? 0)]
        : [0, 0, 0];
      const upperBounds = upper
        ? [Number(upper[0] ?? 0), Number(upper[1] ?? 0), Number(upper[2] ?? 0)]
        : [0, 0, 0];

      const voxelsPerPixel = computeVoxelsPerPixel(viewer);
      const viewportHalfExtents = computeViewportHalfExtents(
        viewer,
        voxelsPerPixel,
      );

      window.parent.postMessage(
        {
          type: "viewport_response",
          requestId,
          position,
          lowerBounds,
          upperBounds,
          voxelsPerPixel,
          viewportHalfExtents,
        },
        "*",
      );
    } catch (e: any) {
      window.parent.postMessage(
        {
          type: "viewport_response",
          requestId,
          error: e?.message ?? String(e),
        },
        "*",
      );
    }
  });
}
