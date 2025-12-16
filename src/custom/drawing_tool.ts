import "#src/custom/drawing_tool.css";
import { RefCounted } from "#src/util/disposable.js";
import { TrackableValue } from "#src/trackable_value.js";
import type { Viewer } from "#src/viewer.js";

type DrawingMode = "brush" | "eraser" | null;
type PromptMode = "point" | "bbox" | "scribble" | "lasso" | null;
type Mode = DrawingMode | PromptMode;

export class DrawingTool extends RefCounted {
  activeMode = new TrackableValue<Mode>(null, x => x);
  promptMode = new TrackableValue<PromptMode>(null, x => x);
  promptPolarity = new TrackableValue<"positive" | "negative">("positive", x => x);
  brushPhysicalSize = new TrackableValue<number>(8, x => x);
  brushPixelSize = new TrackableValue<number>(20, x => x);
  strokeColor = new TrackableValue<string>("#ff0000", x => x);
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  isDrawing = false;
  startX = 0;
  startY = 0;
  snapshot: ImageData | null = null;

  constructor(public viewer: Viewer) {
    super();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "neuroglancer-drawing-canvas";
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.pointerEvents = "none";
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Failed to get 2D context from canvas");
    this.ctx = ctx;
    const container = this.viewer.display.container as HTMLElement;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(this.canvas);
    this.updateSize();
    this.registerEventListener(window, "resize", () => this.updateSize());
    this.activeMode.changed.add(() => this.applyMode());
    this.brushPixelSize.changed.add(() => this.applyMode());
    this.applyMode();
  }

  updateSize() {
    const c = this.viewer.display.container as HTMLElement;
    const rect = c.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }
  }

  applyMode() {
    const mode = this.activeMode.value;
    const promptMode = this.promptMode.value;
    const container = this.viewer.display.container as HTMLElement;
    const set = (v: string) => {
      container.style.setProperty("cursor", v, "important");
      this.canvas.style.setProperty("cursor", v, "important");
    };
    if (mode === "brush") {
      const r = Math.max(2, Math.floor(this.brushPixelSize.value / 2));
      const url = this.makeBrushCursor(r);
      set(`url("${url}") ${r} ${r}, crosshair`);
    } else if (mode === "eraser") {
      const s = Math.max(6, Math.floor(this.brushPixelSize.value));
      const url = this.makeEraserCursor(s);
      const hot = Math.floor(s / 2);
      set(`url("${url}") ${hot} ${hot}, not-allowed`);
    } else if (promptMode === "point") {
      set("crosshair");
    } else if (promptMode === "bbox") {
      set("crosshair");
    } else if (promptMode === "scribble") {
      const r = Math.max(2, 4);
      const url = this.makeBrushCursor(r);
      set(`url("${url}") ${r} ${r}, crosshair`);
    } else if (promptMode === "lasso") {
      set("crosshair");
    } else if (mode) {
      set("crosshair");
    } else {
      set("grab");
    }
  }

  private makeBrushCursor(r: number) {
    const d = r * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="rgba(0,0,0,0.28)" stroke="white" stroke-width="1"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  private makeEraserCursor(s: number) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect x="0.5" y="0.5" width="${s - 1}" height="${s - 1}" fill="rgba(255,255,255,0.15)" stroke="white" stroke-width="1"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  disposed() {
    this.canvas.remove();
    super.disposed();
  }
}
