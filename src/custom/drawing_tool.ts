import "#src/custom/drawing_tool.css";
import { RefCounted } from "#src/util/disposable.js";
import { TrackableValue } from "#src/trackable_value.js";
import type { Viewer } from "#src/viewer.js";

type DrawingMode = "brush" | null;
type PromptMode = "point" | "bbox" | "scribble" | "lasso" | null;
type Mode = DrawingMode | PromptMode;

const PANEL_SELECTOR = ".neuroglancer-rendered-data-panel";

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
  private currentCursor = "";
  private cursorTimer: ReturnType<typeof setInterval> | null = null;

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
    this.promptMode.changed.add(() => this.applyMode());
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

    let cursor = "";
    if (mode === "brush") {
      const r = Math.max(2, Math.floor(this.brushPixelSize.value / 2));
      const url = this.makeBrushCursor(r);
      cursor = `url("${url}") ${r} ${r}, crosshair`;
    } else if (promptMode === "point") {
      const url = this.makePointCursor();
      cursor = `url("${url}") 16 24, default`;
    } else if (promptMode === "bbox") {
      cursor = `crosshair`;
    } else if (promptMode === "scribble") {
      const url = this.makeScribbleCursor();
      cursor = `url("${url}") 5 27, default`;
    } else if (promptMode === "lasso") {
      const url = this.makeLassoCursor();
      cursor = `url("${url}") 7 25, default`;
    } else if (mode) {
      cursor = "crosshair";
    }

    const wasActive = this.currentCursor !== "";
    this.currentCursor = cursor;

    // Apply immediately
    this.enforceCursor();

    // Start or stop periodic enforcement.
    // Neuroglancer's render loop can reset inline cursor styles between frames,
    // so we re-apply every 100 ms while a drawing/prompt mode is active.
    if (cursor && !wasActive) {
      this.cursorTimer = setInterval(() => this.enforceCursor(), 100);
    } else if (!cursor && wasActive) {
      if (this.cursorTimer !== null) {
        clearInterval(this.cursorTimer);
        this.cursorTimer = null;
      }
    }
  }

  private enforceCursor() {
    const container = this.viewer.display.container as HTMLElement;
    const panels = container.querySelectorAll<HTMLElement>(PANEL_SELECTOR);
    if (this.currentCursor) {
      const v = this.currentCursor;
      container.style.setProperty("cursor", v, "important");
      panels.forEach(p => p.style.setProperty("cursor", v, "important"));
    } else {
      container.style.removeProperty("cursor");
      panels.forEach(p => p.style.removeProperty("cursor"));
    }
  }

  private makeBrushCursor(r: number) {
    const d = r * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="rgba(0,0,0,0.28)" stroke="white" stroke-width="1"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  private makePointCursor() {
    // Location pin — matches MdLocationOn toolbar icon, hotspot at pin tip
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M17 4c-3.87 0-7 3.13-7 7 0 4.5 7 14 7 14s7-9.5 7-14c0-3.87-3.13-7-7-7z" fill="rgba(0,0,0,0.3)"/><path d="M16 3c-3.87 0-7 3.13-7 7 0 4.5 7 14 7 14s7-9.5 7-14c0-3.87-3.13-7-7-7z" fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.6)" stroke-width="1.5"/><circle cx="16" cy="10" r="2.5" fill="rgba(0,0,0,0.5)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  private makeScribbleCursor() {
    // Tilted pen — matches MdGesture toolbar icon, hotspot at pen tip
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M6 28l1-6L25 4l4 4L11 26z" fill="rgba(0,0,0,0.25)" transform="translate(1,0)"/><path d="M5 27l1-6L24 3l4 4L10 25z" fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.6)" stroke-width="1.5" stroke-linejoin="round"/><line x1="22" y1="5" x2="26" y2="9" stroke="rgba(0,0,0,0.2)" stroke-width="1"/><circle cx="5" cy="27" r="1.5" fill="rgba(0,0,0,0.5)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  private makeLassoCursor() {
    // Open lasso loop — matches LuLassoSelect toolbar icon, hotspot at start
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M8 26C2 20 2 10 8 5c6-5 16-3 19 4 2.5 6-.5 13-6 17" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="2.5" stroke-linecap="round" transform="translate(1,0)"/><path d="M7 25C1 19 1 9 7 4c6-5 16-3 19 4 2.5 6-.5 13-6 17" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-dasharray="5,3"/><circle cx="7" cy="25" r="3" fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.5)" stroke-width="1.5"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  disposed() {
    if (this.cursorTimer !== null) clearInterval(this.cursorTimer);
    this.currentCursor = "";
    this.enforceCursor();
    this.canvas.remove();
    super.disposed();
  }
}
