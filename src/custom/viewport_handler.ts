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
 *                      upperBounds: [x1, y1, z1] }
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

      window.parent.postMessage(
        {
          type: "viewport_response",
          requestId,
          position,
          lowerBounds,
          upperBounds,
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
