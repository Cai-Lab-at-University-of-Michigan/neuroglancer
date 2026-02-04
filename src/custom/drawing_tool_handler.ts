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

    if (mode === "brush") {
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
      if (isValidPoint(pt)) currentStroke.points.push({ ...pt });
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
        currentStroke = null;
        finishCapture();
        window.parent.postMessage({ type: "drawing_stroke_complete" }, "*");
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
    if (type === "drawing_clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeData.length = 0;
      safeRedraw(viewer);
      return;
    }
    if (type === "prompt_clear") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      promptData.length = 0;
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
          layerInfo?.allSources.flat().forEach((s: any) => s.source.invalidateCache());
        }
      });
      setTimeout(() => {
        viewer.display.panels.forEach((panel: any) => {
          panel?.sliceView?.viewChanged.dispatch();
        });
      }, 100);
      return;
    }
    if (type === "get_viewer_state") {
      const state = (viewer.state as any).toJSON();
      window.parent.postMessage({ type: "viewer_state", state }, "*");
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
