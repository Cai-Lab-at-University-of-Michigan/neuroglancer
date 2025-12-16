import type { DrawingTool } from "#src/custom/drawing_tool.js";
import { ALLOWED_UNITS } from "#src/widget/scale_bar.js";

interface StrokePoint { x: number; y: number; z: number; }
interface BaseStroke { mode: string; color: string; physicalSize: number; voxelSizes: number[] | null; timestamp: string; }
interface BrushStroke extends BaseStroke { mode: "brush" | "eraser"; points: StrokePoint[]; }
interface PromptPoint { mode: "point"; point: StrokePoint; polarity: "positive" | "negative"; }
interface PromptBBox { mode: "bbox"; startPoint: StrokePoint; endPoint: StrokePoint; polarity: "positive" | "negative"; }
interface PromptScribble { mode: "scribble"; points: StrokePoint[]; polarity: "positive" | "negative"; }
interface PromptLasso { mode: "lasso"; points: StrokePoint[]; polarity: "positive" | "negative"; }
type Prompt = PromptPoint | PromptBBox | PromptScribble | PromptLasso;
type Stroke = BrushStroke;

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

function voxelPoint(viewer: any): StrokePoint {
  const s = viewer?.mouseState;
  const p = s?.position;
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

function convertLength(
  value: number,
  fromUnit: string,
  toUnit: string
): number {
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
        const unit = dimensions.physicalUnit ?? "µm";
        return convertLength(dimensions.physicalSizePerPixel, unit, "µm") * 1e6;
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
    window.parent.postMessage({
      type: "scale_bar_update",
      scaleBarLength: scaleBarLength
    }, "*");
  }
}

function calculatePhysicalSizePerVoxel(viewer: any): number[] | null {
  if (!viewer?.display?.panels) return null;

  for (const panel of viewer.display.panels) {
    const sv = panel?.sliceView;
    if (!sv) continue;

    for (const managed of sv.visibleLayerList ?? []) {
      if (managed?.userLayer?.type !== "image") continue;

      const info = sv.visibleLayers?.get?.(managed).displayDimensionRenderInfo;
      const scales = info?.displayDimensionScales;
      const units = info?.displayDimensionUnits;
      if (!scales || !units) continue;

      const scalesArray = Array.from(scales);
      const unitsArray = Array.from(units);

      const converted = scalesArray.map((v, i) =>
        convertLength(v as number, unitsArray[i] as string ?? "m", "µm")
      );
      return converted;
    }
  }
  return null;
}

export function setupDrawingToolMessageHandler(drawingTool: DrawingTool) {
  const canvas = (drawingTool as any).canvas as HTMLCanvasElement;
  const container = (drawingTool as any).viewer.display.container as HTMLElement;
  const viewer = (drawingTool as any).viewer;

  const drawStep = () => {
    rafId = null;
    if (!isCapturing || !pendingXY) return;
    if (!currentStroke && !currentPrompt) return;
    const { x, y } = pendingXY;
    pendingXY = null;
    const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
    const mode = drawingTool.activeMode.value;
    const promptMode = drawingTool.promptMode.value;
    const startX = (drawingTool as any).startX as number;
    const startY = (drawingTool as any).startY as number;
    const snapshot = (drawingTool as any).snapshot as ImageData | null;

    const physicalSizePerPixel = calculatePhysicalSizePerPixel(viewer);
    const pixelSize = physicalSizePerPixel ? drawingTool.brushPhysicalSize.value / physicalSizePerPixel : drawingTool.brushPixelSize.value;

    if (mode === "brush") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = Math.max(1, pixelSize);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFinite(lastScreen.x)) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      ctx.stroke();
    } else if (mode === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = Math.max(1, pixelSize);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFinite(lastScreen.x)) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      ctx.stroke();
    }
    
    else if (promptMode === "bbox") {
      if (snapshot) ctx.putImageData(snapshot, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = 2;
      const w = x - startX;
      const h = y - startY;
      ctx.strokeRect(startX + 0.5, startY + 0.5, w, h);
    } else if (promptMode === "scribble") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFinite(lastScreen.x)) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      ctx.stroke();
    } else if (promptMode === "lasso") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = drawingTool.strokeColor.value;
      ctx.lineWidth = 2;
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

  const onMouseDown = (e: MouseEvent) => {
    const mode = drawingTool.activeMode.value;
    const promptMode = drawingTool.promptMode.value;
    const promptPolarity = drawingTool.promptPolarity.value;
    if ((!mode && !promptMode) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = voxelPoint(viewer);
    const { x: cx, y: cy } = containerCoords(e, container);
    isCapturing = true;
    lastScreen.x = NaN;
    lastScreen.y = NaN;
    (drawingTool as any).startX = cx;
    (drawingTool as any).startY = cy;
    (drawingTool as any).isDrawing = true;

    const physicalSizePerVoxel = calculatePhysicalSizePerVoxel(viewer);
    sendScaleBarUpdate(viewer);

    if (mode === "brush" || mode === "eraser") {
      const baseStroke: BaseStroke = { mode, color: drawingTool.strokeColor.value, physicalSize: drawingTool.brushPhysicalSize.value, voxelSizes: physicalSizePerVoxel, timestamp: new Date().toISOString() };
      currentStroke = { ...baseStroke, points: [] } as BrushStroke;
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (isFinite(pt.x) && isFinite(pt.y) && isFinite(pt.z)) {
        (currentStroke as BrushStroke).points.push({ ...pt });
      }
    }
    
    else if (promptMode === "point") {
      
      if (isFinite(pt.x) && isFinite(pt.y) && isFinite(pt.z)) {
        currentPrompt = { mode: "point", point: pt, polarity: promptPolarity };

        const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = drawingTool.strokeColor.value;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    } else if (promptMode === "bbox") {
      currentPrompt = { mode: "bbox", startPoint: pt, endPoint: pt, polarity: promptPolarity };
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
      (drawingTool as any).snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else if (promptMode === "scribble") {
      currentPrompt = { mode: "scribble", points: [], polarity: promptPolarity };
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (isFinite(pt.x) && isFinite(pt.y) && isFinite(pt.z)) {
        (currentPrompt as PromptScribble).points.push({ ...pt });
      }
    } else if (promptMode === "lasso") {
      currentPrompt = { mode: "lasso", points: [], polarity: promptPolarity };
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      if (isFinite(pt.x) && isFinite(pt.y) && isFinite(pt.z)) {
        (currentPrompt as PromptLasso).points.push({ ...pt });
      }
    }
    const onMove = (ev: MouseEvent) => {
      if (!isCapturing) return;
      if (!currentStroke && !currentPrompt) return;
      const p = voxelPoint(viewer);
      if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
        if (currentStroke) {
          if (currentStroke.mode === "brush" || currentStroke.mode === "eraser") {
            const arr = (currentStroke as BrushStroke).points;
            const last = arr[arr.length - 1];
            if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) arr.push(p);
          }
        } else if (currentPrompt) {
          if (currentPrompt.mode === "bbox") {
            (currentPrompt as PromptBBox).endPoint = p;
          } else if (currentPrompt.mode === "scribble") {
            const arr = (currentPrompt as PromptScribble).points;
            const last = arr[arr.length - 1];
            if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) arr.push(p);
          } else if (currentPrompt.mode === "lasso") {
            const arr = (currentPrompt as PromptLasso).points;
            const last = arr[arr.length - 1];
            if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) arr.push(p);
          }
        }
      }
      const { x, y } = containerCoords(ev, container);
      enqueueDraw(x, y);
    };
    const onUp = () => {
      if (currentStroke) {
        isCapturing = false;
        strokeData.push(currentStroke);
        currentStroke = null;
        (drawingTool as any).isDrawing = false;
        ((drawingTool as any).ctx as CanvasRenderingContext2D).globalCompositeOperation = "source-over";
        (drawingTool as any).snapshot = null;
        window.parent.postMessage({ type: "drawing_stroke_complete" }, "*");
      }
      if (currentPrompt) {
        isCapturing = false;
        promptData.push(currentPrompt);
        currentPrompt = null;
        (drawingTool as any).isDrawing = false;
        ((drawingTool as any).ctx as CanvasRenderingContext2D).globalCompositeOperation = "source-over";
        (drawingTool as any).snapshot = null;
        window.parent.postMessage({ type: "prompt_complete", prompts: promptData }, "*");
      }
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      (drawingTool as any).applyMode?.();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    (drawingTool as any).applyMode?.();
  };

  container.addEventListener("mousedown", onMouseDown, { capture: true });

  window.addEventListener("message", (event) => {
    const { type, mode, size, color, polarity } = event.data ?? {};
    if (type === "screenshot") {
      viewer.screenshotManager.takeScreenshot();
      return;
    }
    if (type === "drawing_mode_change") {
      drawingTool.activeMode.value = mode;
      drawingTool.promptMode.value = null;
      (drawingTool as any).applyMode?.();
      return;
    }
    if (type === "prompt_mode_change") {
      drawingTool.promptMode.value = mode;
      drawingTool.promptPolarity.value = polarity;
      drawingTool.activeMode.value = null;
      (drawingTool as any).applyMode?.();
      return;
    }
    if (type === "drawing_size_change") {
      const viewer = drawingTool.viewer;
      const physicalSizePerPixel = calculatePhysicalSizePerPixel(viewer);
      drawingTool.brushPhysicalSize.value = size;
      drawingTool.brushPixelSize.value = physicalSizePerPixel ? size / physicalSizePerPixel : size;
      (drawingTool as any).applyMode?.();
      return;
    }
    if (type === "drawing_color_change") {
      drawingTool.strokeColor.value = color;
      return;
    }
    if (type === "drawing_clear") {
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeData.length = 0;
      safeRedraw(viewer);
      return;
    }
    if (type === "prompt_clear") {
      const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
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
            { type: "drawing_snapshot_created", imageData: reader.result, strokes: JSON.parse(JSON.stringify(strokeData)) },
            "*"
          );
          const ctx = (drawingTool as any).ctx as CanvasRenderingContext2D;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          strokeData.length = 0;
          safeRedraw(viewer);
        };
        reader.readAsDataURL(blob);
      });
      return;
    }

    if (type === "invalidate_chunks") {
      viewer.display.panels.forEach((panel: any) => {
        if (panel?.sliceView) {
          const visibleLayerList = Array.from(panel.sliceView.visibleLayerList);

          visibleLayerList.forEach((managedLayer: any) => {
            if (managedLayer?.userLayer?.type === "segmentation") {
              const layerInfo = panel.sliceView.visibleLayers.get(managedLayer);
              layerInfo?.allSources.flat().forEach((tsource: any) => tsource.source.invalidateCache());
            }
          });
        }
      });

      setTimeout(() => {
        viewer.display.panels.forEach((panel: any) => {
          panel?.sliceView?.viewChanged.dispatch();
        });
      }, 100);
      return;
    }
  });

  const navigationState = viewer?.navigationState;
  if (navigationState?.zoomFactor) {
    navigationState.zoomFactor.changed.add(() => {
      sendScaleBarUpdate(viewer);
    });
  }

  sendScaleBarUpdate(viewer);
}
