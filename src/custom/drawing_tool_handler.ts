import type { DrawingTool } from "#src/custom/drawing_tool.js";
import { ALLOWED_UNITS } from "#src/widget/scale_bar.js";

interface StrokePoint {
  x: number;
  y: number;
  z: number;
}

interface BaseStroke {
  mode: string;
  color: string;
  physicalSize: number;
  voxelSizes: number[] | null;
  timestamp: string;
}

interface BrushStroke extends BaseStroke {
  mode: "brush";
  points: StrokePoint[];
}

interface PromptPoint {
  mode: "point";
  point: StrokePoint;
  polarity: "positive" | "negative";
}

interface PromptBBox {
  mode: "bbox";
  startPoint: StrokePoint;
  endPoint: StrokePoint;
  polarity: "positive" | "negative";
}

interface PromptScribble {
  mode: "scribble";
  points: StrokePoint[];
  polarity: "positive" | "negative";
}

interface PromptLasso {
  mode: "lasso";
  points: StrokePoint[];
  polarity: "positive" | "negative";
}

type Prompt = PromptPoint | PromptBBox | PromptScribble | PromptLasso;
type Stroke = BrushStroke;

const DATA_PANEL_SELECTOR = ".neuroglancer-rendered-data-panel";

const strokeData: Stroke[] = [];
const promptData: Prompt[] = [];
let currentStroke: Stroke | null = null;
let currentPrompt: Prompt | null = null;
let isCapturing = false;
let rafId: number | null = null;
let pendingXY: { x: number; y: number } | null = null;
let lastScaleBarLength: number | null = null;
const minPixelStep = 0.75;
const lastScreen = { x: NaN, y: NaN };

// Locked view state for visual indicator
interface LockedBBox {
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
  z_start: number;
  z_end: number;
}
let lockedBBox: LockedBBox | null = null;
let lockedPosition: Float32Array | null = null;
let lockedZoomFactor: number | null = null;

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function getSliceViewPanels(viewer: any): { element: HTMLElement; panel: any }[] {
  // Find all 2D slice view panels (xy, xz, yz projections)
  // These are the panels where annotation should be allowed
  const results: { element: HTMLElement; panel: any }[] = [];

  if (!viewer?.display?.panels) return results;

  for (const panel of viewer.display.panels) {
    // SliceView panels have a sliceView property
    // PerspectiveView (3D) panels do not have sliceView
    if (!panel?.sliceView) continue;

    // Get the panel's DOM element
    const element = panel.element as HTMLElement;
    if (!element) continue;

    results.push({ element, panel });
  }

  return results;
}

function drawLockedRegionIndicator(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  viewer: any,
  bbox: LockedBBox | null
) {
  // Clear previous indicator (use backing pixel dimensions for clearRect)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform for clearing
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  if (!bbox) return;

  // Get container rect for coordinate calculation
  const container = viewer?.display?.container as HTMLElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();

  // Find all 2D slice view panels
  const slicePanels = getSliceViewPanels(viewer);

  if (slicePanels.length === 0) return;

  // Draw border around each slice view panel
  ctx.strokeStyle = "rgba(34, 197, 94, 0.6)"; // green-500 with opacity
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 4]);

  let firstPanelRect: DOMRect | null = null;

  for (const { element } of slicePanels) {
    const panelRect = element.getBoundingClientRect();

    // Convert to container-relative coordinates
    const x = panelRect.left - containerRect.left;
    const y = panelRect.top - containerRect.top;
    const w = panelRect.width;
    const h = panelRect.height;

    // Draw border around this panel
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);

    // Remember first panel for badge placement
    if (!firstPanelRect) {
      firstPanelRect = panelRect;
    }
  }

  ctx.setLineDash([]);

  // Draw badge in the first slice panel (top-right corner)
  if (firstPanelRect) {
    const badgeText = "🔒 VIEW LOCKED";
    ctx.font = "bold 12px sans-serif";
    const textMetrics = ctx.measureText(badgeText);
    const padding = 8;
    const badgeWidth = textMetrics.width + padding * 2;
    const badgeHeight = 20;

    // Position badge in top-right corner of the first panel
    const panelRight = (firstPanelRect.left - containerRect.left) + firstPanelRect.width;
    const badgeX = panelRight - badgeWidth - 10;
    const badgeY = (firstPanelRect.top - containerRect.top) + 10;

    // Badge background (using manual rounded rect for compatibility)
    ctx.fillStyle = "rgba(34, 197, 94, 0.9)"; // green-500
    drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 4);
    ctx.fill();

    // Badge text
    ctx.fillStyle = "white";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, badgeX + padding, badgeY + badgeHeight / 2);
  }
}

function sendAnnotationStateUpdate(parent: Window) {
  parent.postMessage({
    type: "annotation_state_update",
    strokeCount: strokeData.length,
    canUndo: strokeData.length > 0,
    canRedo: false,  // Redo now managed by backend
  }, "*");
}

function isValidPoint(p: StrokePoint): boolean {
  return isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
}

function isInDataBounds(viewer: any): boolean {
  const pos = viewer?.mouseState?.position;
  const bounds = viewer?.coordinateSpace?.value?.bounds;
  if (!pos || pos.length < 3 || !bounds) return false;
  const { lowerBounds, upperBounds } = bounds;
  for (let i = 0; i < 3; i++) {
    if (!isFinite(pos[i])) return false;
    if (pos[i] < lowerBounds[i] || pos[i] >= upperBounds[i]) return false;
  }
  return true;
}

function pushUniquePoint(arr: StrokePoint[], p: StrokePoint) {
  const last = arr[arr.length - 1];
  if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) {
    arr.push(p);
  }
}

function isOnDataPanel(e: MouseEvent): boolean {
  return !!(e.target as HTMLElement).closest(DATA_PANEL_SELECTOR);
}

function voxelPoint(viewer: any): StrokePoint {
  const p = viewer?.mouseState?.position;
  if (!p || p.length < 3) return { x: NaN, y: NaN, z: NaN };

  // Map position to x, y, z based on coordinate space dimension names
  const coordSpace = viewer?.coordinateSpace?.value;
  const names = coordSpace?.names;
  if (names && names.length >= 3) {
    const idx_x = names.indexOf("x");
    const idx_y = names.indexOf("y");
    const idx_z = names.indexOf("z");
    if (idx_x >= 0 && idx_y >= 0 && idx_z >= 0) {
      return { x: p[idx_x], y: p[idx_y], z: p[idx_z] };
    }
  }
  // Fallback: assume position order is [x, y, z]
  return { x: p[0], y: p[1], z: p[2] };
}

function containerCoords(e: MouseEvent, container: HTMLElement) {
  const r = container.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function safeRedraw(viewer: any) {
  viewer?.display?.scheduleRedraw?.();
}

function convertLength(value: number, fromUnit: string, toUnit: string): number {
  const from = ALLOWED_UNITS.find(u => u.unit === fromUnit);
  const to = ALLOWED_UNITS.find(u => u.unit === toUnit);
  if (!from || !to) throw new Error(`Unsupported unit conversion: ${fromUnit} to ${toUnit}`);
  return value * (from.lengthInNanometers / to.lengthInNanometers);
}

function calculatePhysicalSizePerPixel(viewer: any): number | null {
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

function getScaleBarPhysicalLength(viewer: any): number | null {
  if (!viewer?.display?.panels) return null;
  for (const panel of viewer.display.panels) {
    const scaleBars = panel?.scaleBars?.scaleBars;
    if (!scaleBars) continue;
    for (const scaleBar of scaleBars) {
      const dimensions = scaleBar?.dimensions;
      if (dimensions?.physicalLength) {
        const unit = dimensions.physicalUnit ?? "µm";
        return convertLength(dimensions.physicalLength, unit, "µm");
      }
    }
  }
  return null;
}

function sendScaleBarUpdate(viewer: any) {
  const scaleBarLength = getScaleBarPhysicalLength(viewer);
  if (scaleBarLength !== null && scaleBarLength !== lastScaleBarLength) {
    lastScaleBarLength = scaleBarLength;
    window.parent.postMessage({ type: "scale_bar_update", scaleBarLength }, "*");
  }
}

function calculatePhysicalSizePerVoxel(viewer: any): number[] | null {
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

// ---------------------------------------------------------------------------

export function setupDrawingToolMessageHandler(drawingTool: DrawingTool) {
  const { canvas, ctx, viewer } = drawingTool;
  const container = viewer.display.container as HTMLElement;

  const getPixelSize = () => {
    const ppp = calculatePhysicalSizePerPixel(viewer);
    return ppp ? drawingTool.brushPhysicalSize.value / ppp : drawingTool.brushPixelSize.value;
  };

  // -- Canvas rendering (rAF) -----------------------------------------------

  const drawStep = () => {
    rafId = null;
    if (!isCapturing || !pendingXY) return;
    if (!currentStroke && !currentPrompt) return;
    const { x, y } = pendingXY;
    pendingXY = null;

    const mode = drawingTool.activeMode.value;
    const promptMode = drawingTool.promptMode.value;

    if (mode === "brush") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = Math.max(1, getPixelSize());
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFinite(lastScreen.x)) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      ctx.stroke();
    } else if (promptMode === "bbox") {
      if (drawingTool.snapshot) ctx.putImageData(drawingTool.snapshot, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = 2;
      ctx.strokeRect(drawingTool.startX + 0.5, drawingTool.startY + 0.5, x - drawingTool.startX, y - drawingTool.startY);
    } else if (promptMode === "scribble" || promptMode === "lasso") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = promptMode === "scribble" ? 4 : 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFinite(lastScreen.x)) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      ctx.stroke();
    }

    lastScreen.x = x;
    lastScreen.y = y;
  };

  const enqueueDraw = (x: number, y: number) => {
    if (isFinite(lastScreen.x)) {
      const dx = x - lastScreen.x;
      const dy = y - lastScreen.y;
      if (dx * dx + dy * dy < minPixelStep * minPixelStep) return;
    }
    pendingXY = { x, y };
    if (rafId === null) rafId = window.requestAnimationFrame(drawStep);
  };

  // -- Capture helpers ------------------------------------------------------

  const finishCapture = () => {
    isCapturing = false;
    drawingTool.isDrawing = false;
    ctx.globalCompositeOperation = "source-over";
    drawingTool.snapshot = null;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    drawingTool.applyMode();
  };

  // -- Mouse handlers -------------------------------------------------------

  const onMouseDown = (e: MouseEvent) => {
    const mode = drawingTool.activeMode.value;
    const promptMode = drawingTool.promptMode.value;
    const promptPolarity = drawingTool.promptPolarity.value;
    if ((!mode && !promptMode) || e.button !== 0) return;

    // Only allow drawing/prompting on the rendered data panels (the image area)
    if (!isOnDataPanel(e)) return;

    // Reject clicks outside the actual data volume (e.g. empty/black area around image)
    if (!isInDataBounds(viewer)) return;

    const pt = voxelPoint(viewer);

    e.preventDefault();
    e.stopPropagation();
    const { x: cx, y: cy } = containerCoords(e, container);
    isCapturing = true;
    lastScreen.x = NaN;
    lastScreen.y = NaN;
    drawingTool.startX = cx;
    drawingTool.startY = cy;
    drawingTool.isDrawing = true;

    const physicalSizePerVoxel = calculatePhysicalSizePerVoxel(viewer);
    sendScaleBarUpdate(viewer);

    // Send voxel sizes to parent for backend stroke processing
    if (physicalSizePerVoxel) {
      window.parent.postMessage({
        type: "voxel_sizes_update",
        voxelSizes: physicalSizePerVoxel as [number, number, number],
      }, "*");
    }

    if (mode === "brush" || mode === "eraser") {
      currentStroke = {
        mode: "brush",
        color: drawingTool.strokeColor.value,
        physicalSize: drawingTool.brushPhysicalSize.value,
        voxelSizes: physicalSizePerVoxel,
        timestamp: new Date().toISOString(),
        points: [],
      };
      ctx.beginPath();
      ctx.moveTo(cx, cy);

      if (isValidPoint(pt)) {
        currentStroke.points.push({ ...pt });
      }
    } else if (promptMode === "point") {
      if (isValidPoint(pt)) {
        currentPrompt = { mode: "point", point: pt, polarity: promptPolarity };
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = drawingTool.strokeColor.value;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    } else if (promptMode === "bbox") {
      currentPrompt = { mode: "bbox", startPoint: pt, endPoint: pt, polarity: promptPolarity };
      drawingTool.snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else if (promptMode === "scribble") {
      currentPrompt = { mode: "scribble", points: [], polarity: promptPolarity };
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (isValidPoint(pt)) (currentPrompt as PromptScribble).points.push({ ...pt });
    } else if (promptMode === "lasso") {
      currentPrompt = { mode: "lasso", points: [], polarity: promptPolarity };
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (isValidPoint(pt)) (currentPrompt as PromptLasso).points.push({ ...pt });
    }

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };

    const commitStroke = () => {
      cleanup();
      if (currentStroke) {
        strokeData.push(currentStroke);
        // Send stroke data directly with the completion message for backend processing
        const isEraserMode = drawingTool.activeMode.value === "eraser" || drawingTool.isEraser.value;

        window.parent.postMessage({
          type: "drawing_stroke_complete",
          stroke: {
            mode: currentStroke.mode,
            points: currentStroke.points,
            physicalSize: currentStroke.physicalSize,
            voxelSizes: currentStroke.voxelSizes,
            color: currentStroke.color,
            timestamp: currentStroke.timestamp,
            isEraser: isEraserMode,
          },
        }, "*");

        // Send state update to parent
        sendAnnotationStateUpdate(window.parent);

        currentStroke = null;
        finishCapture();
      }
      if (currentPrompt) {
        promptData.push(currentPrompt);
        currentPrompt = null;
        finishCapture();
        window.parent.postMessage({ type: "prompt_complete", prompts: promptData }, "*");
      }
    };

    const onMove = (ev: MouseEvent) => {
      if (!isCapturing) return;
      if (!currentStroke && !currentPrompt) return;

      // Skip recording/drawing when mouse is outside the data area,
      // but keep listeners alive so neuroglancer's state isn't confused
      if (!isOnDataPanel(ev) || !isInDataBounds(viewer)) {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        pendingXY = null;
        return;
      }
      const p = voxelPoint(viewer);

      if (currentStroke) {
        pushUniquePoint(currentStroke.points, p);
      } else if (currentPrompt) {
        if (currentPrompt.mode === "bbox") {
          (currentPrompt as PromptBBox).endPoint = p;
        } else if (currentPrompt.mode === "scribble") {
          pushUniquePoint((currentPrompt as PromptScribble).points, p);
        } else if (currentPrompt.mode === "lasso") {
          pushUniquePoint((currentPrompt as PromptLasso).points, p);
        }
      }
      const { x, y } = containerCoords(ev, container);
      enqueueDraw(x, y);
    };

    const onUp = () => {
      commitStroke();
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    drawingTool.applyMode();
  };

  container.addEventListener("mousedown", onMouseDown, { capture: true });

  // -- Navigation lock when view is locked ----------------------------------
  // Block pan (drag) on slice view panels when locked (zoom is allowed)

  const isOnSliceViewPanel = (target: HTMLElement): boolean => {
    if (!target.closest(DATA_PANEL_SELECTOR)) return false;
    const slicePanels = getSliceViewPanels(viewer);
    return slicePanels.some(({ element }) =>
      element.contains(target) || element === target
    );
  };

  // Block ALL mouse buttons on slice panels when locked (pan, rotate, etc.)
  // This runs BEFORE the drawing tool's mousedown handler
  container.addEventListener("mousedown", (e: MouseEvent) => {
    if (!lockedBBox) return;
    if (!isOnSliceViewPanel(e.target as HTMLElement)) return;

    const mode = drawingTool.activeMode.value;
    const promptMode = drawingTool.promptMode.value;

    // If no drawing/prompt mode is active, block ALL clicks to prevent navigation
    if (!mode && !promptMode) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // If in drawing/prompt mode, only block right-click and middle-click
    // Left-click is handled by the drawing tool
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  // Block keyboard navigation when locked (arrow keys, etc.)
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!lockedBBox) return;

    // Block navigation keys on slice panels
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];
    if (!navKeys.includes(e.key)) return;

    const target = e.target as HTMLElement;
    if (target.closest(DATA_PANEL_SELECTOR)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  // -- Redraw locked indicator on resize ------------------------------------
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (!lockedBBox) return;

    // Debounce: wait for resize to settle, then redraw
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
    }, 100);
  });

  // -- Incoming messages from parent ----------------------------------------

  window.addEventListener("message", (event) => {
    const { type, mode, size, color, polarity } = event.data ?? {};

    if (type === "screenshot") {
      viewer.screenshotManager.takeScreenshot();
      return;
    }
    if (type === "drawing_mode_change") {
      drawingTool.activeMode.value = mode;
      drawingTool.promptMode.value = null;
      drawingTool.applyMode();
      return;
    }
    if (type === "prompt_mode_change") {
      drawingTool.promptMode.value = mode;
      drawingTool.promptPolarity.value = polarity;
      drawingTool.activeMode.value = null;
      drawingTool.applyMode();
      return;
    }
    if (type === "drawing_size_change") {
      const ppp = calculatePhysicalSizePerPixel(viewer);
      drawingTool.brushPhysicalSize.value = size;
      if (ppp) {
        const voxelSizes = calculatePhysicalSizePerVoxel(viewer);
        const minPx = voxelSizes ? Math.max(1, Math.round(Math.min(...voxelSizes) / ppp)) : 1;
        drawingTool.brushPixelSize.value = Math.max(minPx, size / ppp);
      } else {
        drawingTool.brushPixelSize.value = size;
      }
      drawingTool.applyMode();
      return;
    }
    if (type === "drawing_color_change") {
      drawingTool.strokeColor.value = color;
      return;
    }
    if (type === "eraser_mode_change") {
      drawingTool.isEraser.value = event.data.isEraser ?? false;
      drawingTool.applyMode();
      return;
    }
    if (type === "annotation_undo") {
      // Undo is managed by backend - just clear canvas and redraw
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeData.length = 0;
      if (lockedBBox) {
        drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      }
      sendAnnotationStateUpdate(window.parent);
      safeRedraw(viewer);
      return;
    }
    if (type === "annotation_redo") {
      // Redo is managed by backend - just trigger redraw
      sendAnnotationStateUpdate(window.parent);
      safeRedraw(viewer);
      return;
    }
    if (type === "annotation_clear") {
      // Clear canvas overlay
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeData.length = 0;
      if (lockedBBox) {
        drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      }
      sendAnnotationStateUpdate(window.parent);
      safeRedraw(viewer);
      return;
    }
    if (type === "annotation_state_sync") {
      // Sync visual state with backend annotation state
      const { strokeCount } = event.data;
      if (strokeCount === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        strokeData.length = 0;
      }
      if (lockedBBox) {
        drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      }
      sendAnnotationStateUpdate(window.parent);
      // Always trigger redraw to show updated LocalVolume data
      safeRedraw(viewer);
      return;
    }
    if (type === "drawing_clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeData.length = 0;
      // Redraw locked indicator if view is locked
      if (lockedBBox) {
        drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      }
      safeRedraw(viewer);
      return;
    }
    if (type === "prompt_clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      promptData.length = 0;
      // Redraw locked indicator if view is locked
      if (lockedBBox) {
        drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      }
      safeRedraw(viewer);
      return;
    }
    if (type === "drawing_snapshot") {
      canvas.toBlob((blob: Blob | null) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          window.parent.postMessage(
            {
              type: "drawing_snapshot_created",
              imageData: reader.result,
              strokes: JSON.parse(JSON.stringify(strokeData)),
            },
            "*",
          );
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          strokeData.length = 0;
          // Redraw locked indicator if view is locked
          if (lockedBBox) {
            drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
          }
          safeRedraw(viewer);
        };
        reader.readAsDataURL(blob);
      });
      return;
    }
    if (type === "segment_hover") {
      const segId = event.data.segmentId;
      for (const managedLayer of viewer?.layerManager?.managedLayers ?? []) {
        const layer = (managedLayer as any)?.layer;
        if (layer?.type !== "segmentation") continue;
        const selectionState = layer?.displayState?.segmentSelectionState;
        if (selectionState) {
          if (segId !== null && segId !== undefined) {
            selectionState.set(BigInt(segId));
          } else {
            selectionState.set(null);
          }
        }
      }
      return;
    }
    if (type === "segment_recolor") {
      for (const managedLayer of viewer?.layerManager?.managedLayers ?? []) {
        const layer = (managedLayer as any)?.layer;
        if (layer?.type !== "segmentation") continue;
        const colorHash = layer?.displayState?.segmentationColorGroupState?.value?.segmentColorHash;
        if (colorHash) {
          colorHash.randomize();
        }
      }
      return;
    }
    if (type === "invalidate_chunks") {
      viewer.display.panels.forEach((panel: any) => {
        if (!panel?.sliceView) return;
        for (const managedLayer of panel.sliceView.visibleLayerList) {
          if (managedLayer?.userLayer?.type !== "segmentation") continue;
          const layerInfo = panel.sliceView.visibleLayers.get(managedLayer);
          layerInfo?.allSources?.flat().forEach((s: any) => s?.source?.invalidateCache?.());
        }
      });
      setTimeout(() => {
        viewer.display.panels.forEach((panel: any) => {
          panel?.sliceView?.viewChanged?.dispatch?.();
        });
        viewer.display.scheduleRedraw();
      }, 100);
      return;
    }
    if (type === "get_viewer_state") {
      const state = (viewer.state as any).toJSON();
      window.parent.postMessage({ type: "viewer_state", state }, "*");
      return;
    }
    if (type === "view_locked") {
      // Store locked bbox and show visual indicator
      lockedBBox = event.data.bbox ?? null;
      // Store position and zoom for reset functionality
      const navState = viewer?.navigationState;
      if (navState?.position?.value) {
        lockedPosition = new Float32Array(navState.position.value);
      }
      if (navState?.zoomFactor?.value !== undefined) {
        lockedZoomFactor = navState.zoomFactor.value;
      }
      drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
      return;
    }
    if (type === "view_unlocked") {
      // Clear locked bbox indicator and stored position/zoom
      lockedBBox = null;
      lockedPosition = null;
      lockedZoomFactor = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      safeRedraw(viewer);
      return;
    }
    if (type === "reset_to_locked_view") {
      // Restore position and zoom to locked state
      const navState = viewer?.navigationState;
      if (lockedPosition && navState?.position) {
        navState.position.value = new Float32Array(lockedPosition);
      }
      if (lockedZoomFactor !== null && navState?.zoomFactor) {
        navState.zoomFactor.value = lockedZoomFactor;
      }
      safeRedraw(viewer);
      return;
    }
    if (type === "plugin_activated") {
      activatePluginBindings(event.data.pluginId, event.data.shortcuts ?? []);
      return;
    }
    if (type === "plugin_deactivated") {
      deactivatePluginBindings();
      return;
    }
    if (type === "get_view_state") {
      // Get current view state for lock-view
      // Everything stays in mip 0 coordinates (global coordinate space)
      const navState = viewer?.navigationState;
      const pos = navState?.position?.value;
      const coordSpace = viewer?.coordinateSpace?.value;
      const bounds = coordSpace?.bounds;
      const physicalPerPixel = calculatePhysicalSizePerPixel(viewer);

      // Find dimension indices for x, y, z (coordinate space order may vary)
      const names = coordSpace?.names ?? [];
      const idx_x = names.indexOf("x");
      const idx_y = names.indexOf("y");
      const idx_z = names.indexOf("z");
      const hasValidIndices = idx_x >= 0 && idx_y >= 0 && idx_z >= 0;

      // Get base voxel sizes in XYZ order (not coordinate space order)
      let voxelSizes: [number, number, number] | null = null;
      if (coordSpace?.scales && coordSpace?.units && hasValidIndices) {
        const scales = Array.from(coordSpace.scales) as number[];
        const units = Array.from(coordSpace.units) as string[];
        voxelSizes = [
          convertLength(scales[idx_x], units[idx_x] ?? "m", "µm"),
          convertLength(scales[idx_y], units[idx_y] ?? "m", "µm"),
          convertLength(scales[idx_z], units[idx_z] ?? "m", "µm"),
        ];
      }

      // Calculate visible bbox in mip 0 coordinates
      let bbox = null;
      if (bounds && pos && physicalPerPixel && voxelSizes && hasValidIndices) {
        const panels = Array.from(viewer.display.panels);
        const panel = panels.find((p: any) => p?.sliceView) as any;

        if (panel?.sliceView) {
          const vpWidth = panel.element.offsetWidth ?? 800;
          const vpHeight = panel.element.offsetHeight ?? 600;

          // Viewport size in physical units (µm)
          const vpPhysWidth = vpWidth * physicalPerPixel;
          const vpPhysHeight = vpHeight * physicalPerPixel;

          // Convert to mip 0 voxels using XYZ voxel sizes
          const halfW = Math.ceil((vpPhysWidth / voxelSizes[0]) / 2);
          const halfH = Math.ceil((vpPhysHeight / voxelSizes[1]) / 2);

          // Get bounds in XYZ order
          const upperX = bounds.upperBounds[idx_x];
          const upperY = bounds.upperBounds[idx_y];
          const upperZ = bounds.upperBounds[idx_z];

          if (!isFinite(upperX) || !isFinite(upperY) || !isFinite(upperZ)) {
            window.parent.postMessage({
              type: "view_state",
              position: pos ? [pos[idx_x], pos[idx_y], pos[idx_z]] : null,
              scaleIndex: 0,
              bbox: null,
              voxelSizes: voxelSizes ?? null,
              scaleFactors: [1, 1, 1],
              error: "Image bounds not available",
            }, "*");
            return;
          }

          // Get position in XYZ order
          const posX = pos[idx_x];
          const posY = pos[idx_y];
          const posZ = pos[idx_z];

          // Z range: a few slices around current position
          const zSlices = 10;

          // Calculate bbox in mip 0 coords and clamp to image bounds
          const x_start = Math.max(0, Math.floor(posX - halfW));
          const x_end = Math.min(Math.floor(upperX), Math.ceil(posX + halfW));
          const y_start = Math.max(0, Math.floor(posY - halfH));
          const y_end = Math.min(Math.floor(upperY), Math.ceil(posY + halfH));
          const z_start = Math.max(0, Math.floor(posZ - zSlices / 2));
          const z_end = Math.min(Math.floor(upperZ), Math.ceil(posZ + zSlices / 2));

          // Ensure bbox has positive dimensions
          if (x_end > x_start && y_end > y_start && z_end > z_start) {
            bbox = { x_start, x_end, y_start, y_end, z_start, z_end };
          }
        }
      }

      // Calculate actual scale factor from zoom level (in XYZ order)
      // Scale factor = how many mip 0 voxels per screen pixel at current zoom
      let scaleFactors: [number, number, number] = [1, 1, 1];
      if (physicalPerPixel && voxelSizes) {
        scaleFactors = [
          physicalPerPixel / voxelSizes[0],
          physicalPerPixel / voxelSizes[1],
          physicalPerPixel / voxelSizes[2],
        ];
      }

      window.parent.postMessage({
        type: "view_state",
        position: pos && hasValidIndices ? [pos[idx_x], pos[idx_y], pos[idx_z]] : null,
        scaleIndex: 0,
        bbox,
        voxelSizes: voxelSizes ?? null,
        scaleFactors,
      }, "*");
      return;
    }
  });

  // -- Zoom tracking --------------------------------------------------------

  let zoomRafId: number | null = null;
  const recalcPixelSize = () => {
    const ppp = calculatePhysicalSizePerPixel(viewer);
    if (ppp) {
      // Ensure cursor covers at least 1 voxel on screen
      const voxelSizes = calculatePhysicalSizePerVoxel(viewer);
      const minPx = voxelSizes ? Math.max(1, Math.round(Math.min(...voxelSizes) / ppp)) : 1;
      const next = Math.max(minPx, Math.round(drawingTool.brushPhysicalSize.value / ppp));
      if (next !== Math.round(drawingTool.brushPixelSize.value)) {
        drawingTool.brushPixelSize.value = next;
      }
    }
  };

  const navigationState = viewer?.navigationState;
  if (navigationState?.zoomFactor) {
    navigationState.zoomFactor.changed.add(() => {
      sendScaleBarUpdate(viewer);
      if (zoomRafId === null) {
        zoomRafId = window.requestAnimationFrame(() => {
          zoomRafId = null;
          recalcPixelSize();
        });
      }
    });
  }
  sendScaleBarUpdate(viewer);

  // -- Segment color hash seed tracking -------------------------------------

  const sendColorHashSeed = () => {
    for (const managedLayer of viewer?.layerManager?.managedLayers ?? []) {
      const layer = (managedLayer as any)?.layer;
      if (layer?.type !== "segmentation") continue;
      const colorHash = layer?.displayState?.segmentationColorGroupState?.value?.segmentColorHash;
      if (colorHash) {
        window.parent.postMessage({
          type: "segment_color_seed",
          seed: colorHash.value ?? 0,
          layerName: managedLayer.name,
        }, "*");
        colorHash.changed.add(() => {
          window.parent.postMessage({
            type: "segment_color_seed",
            seed: colorHash.value ?? 0,
            layerName: managedLayer.name,
          }, "*");
        });
      }
    }
  };

  // -- Segment hover tracking (neuroglancer → parent) -----------------------

  let lastHoveredSegId: string | null = null;
  const sendSegmentHoverState = () => {
    for (const managedLayer of viewer?.layerManager?.managedLayers ?? []) {
      const layer = (managedLayer as any)?.layer;
      if (layer?.type !== "segmentation") continue;
      const selectionState = layer?.displayState?.segmentSelectionState;
      if (selectionState?.changed) {
        selectionState.changed.add(() => {
          const raw = selectionState.value;
          const segId = raw !== undefined ? raw.toString() : null;
          if (segId !== lastHoveredSegId) {
            lastHoveredSegId = segId;
            window.parent.postMessage({
              type: "segment_hover_sync",
              segmentId: segId !== null ? Number(segId) : null,
            }, "*");
          }
        });
      }
    }
  };

  // Send initial seed after a short delay to ensure layers are loaded
  setTimeout(() => { sendColorHashSeed(); sendSegmentHoverState(); }, 500);

  // Re-check when layers change
  viewer?.layerManager?.layersChanged?.add?.(() => {
    setTimeout(() => { sendColorHashSeed(); sendSegmentHoverState(); }, 100);
  });

  // -- Resize observer for locked region indicator --------------------------
  // Redraw the green bbox/badge when the panel size changes
  // Observe both the container AND individual slice view panels since neuroglancer
  // may resize panels independently (e.g., when dragging splitters)

  let resizeRafId: number | null = null;
  const observedElements = new Set<Element>();

  const onResize = () => {
    // Debounce with rAF to avoid excessive redraws
    if (resizeRafId === null) {
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        // Update canvas size first (match DrawingTool.updateSize)
        drawingTool.updateSize();
        // Redraw locked region indicator if view is locked
        if (lockedBBox) {
          drawLockedRegionIndicator(ctx, canvas, viewer, lockedBBox);
        }
      });
    }
  };

  const resizeObserver = new ResizeObserver(onResize);

  // Observe container
  resizeObserver.observe(container);
  observedElements.add(container);

  // Also observe individual slice view panels
  const observeSlicePanels = () => {
    const slicePanels = getSliceViewPanels(viewer);
    for (const { element } of slicePanels) {
      if (!observedElements.has(element)) {
        resizeObserver.observe(element);
        observedElements.add(element);
      }
    }
  };

  // Initial observation
  observeSlicePanels();

  // Re-observe when layout changes (use display changed signal)
  viewer?.display?.changed?.add?.(() => {
    setTimeout(observeSlicePanels, 100);
  });

  // Also watch for layer changes which may affect panel layout
  viewer?.layerManager?.layersChanged?.add?.(() => {
    setTimeout(observeSlicePanels, 100);
  });

  // -- Keyboard shortcut interception (capture phase) -----------------------
  // Uses a capture-phase keydown listener to intercept keys BEFORE
  // neuroglancer processes them, preventing conflicts with NG defaults.

  const portalShortcuts: Record<string, string> = {
    s: "portal-save-scene",
    d: "portal-download-roi",
    k: "portal-show-cheatsheet",
  };

  let activePluginId: string | null = null;
  let activePluginKeys = new Set<string>();

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Portal shortcuts: Ctrl/Cmd + S/D/K
    if (ctrlOrCmd && portalShortcuts[key]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.parent.postMessage({
        type: "portal_action",
        action: portalShortcuts[key],
      }, "*");
      return;
    }

    // Undo/Redo shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z
    if (activePluginId && ctrlOrCmd && key === "z") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const shortcutKey = e.shiftKey
        ? (e.metaKey ? "cmd+shift+z" : "ctrl+shift+z")
        : (e.metaKey ? "cmd+z" : "ctrl+z");
      window.parent.postMessage({
        type: "plugin_shortcut",
        key: shortcutKey,
        pluginId: activePluginId,
      }, "*");
      return;
    }

    // Plugin shortcuts: plain keys (no ctrl/cmd/alt)
    if (activePluginId && !ctrlOrCmd && !e.altKey && activePluginKeys.has(key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.parent.postMessage({
        type: "plugin_shortcut",
        key,
        pluginId: activePluginId,
      }, "*");
      return;
    }
  }, true); // capture phase

  function activatePluginBindings(pluginId: string, shortcuts: string[]) {
    activePluginId = pluginId;
    activePluginKeys = new Set(shortcuts.map(k => k.toLowerCase()));
  }

  function deactivatePluginBindings() {
    activePluginId = null;
    activePluginKeys.clear();
  }
}
