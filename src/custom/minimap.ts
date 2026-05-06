import "#src/custom/minimap.css";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

// User-adjustable size of the minimap along its longer axis. The MIP
// PNGs are stored at 256 px max on the server, so the practical sweet
// spot is 128–256 px; outside that range we'd be either over-shrinking
// useful detail or upscaling beyond the source resolution.
const MINIMAP_SIZE_MIN = 128;
const MINIMAP_SIZE_MAX = 256;
const MINIMAP_SIZE_DEFAULT = 128;
const MINIMAP_SIZE_STORAGE_KEY = "neuroglancer-minimap-size";

// Lower bound of the SHORTER axis so the minimap never collapses to a
// sliver on extremely anisotropic datasets. Scales with the user's
// chosen long-axis size.
const MINIMAP_MIN_SHORT_RATIO = 0.33;

function loadSavedSize(): number {
  try {
    const raw = window.localStorage?.getItem(MINIMAP_SIZE_STORAGE_KEY);
    if (raw) {
      const n = Math.round(Number(raw));
      if (Number.isFinite(n)) {
        return Math.min(MINIMAP_SIZE_MAX, Math.max(MINIMAP_SIZE_MIN, n));
      }
    }
  } catch {
    // localStorage may be disabled in some contexts; fall back to default.
  }
  return MINIMAP_SIZE_DEFAULT;
}

function saveSize(size: number): void {
  try {
    window.localStorage?.setItem(MINIMAP_SIZE_STORAGE_KEY, String(size));
  } catch {
    // ignore quota / disabled storage
  }
}

// Subscribers notified when the user resizes any minimap. Used so a
// resize on one panel's minimap also resizes its siblings.
const minimapResizeSubscribers = new Set<(size: number) => void>();
const VIEWPORT_COLOR = "#ffcc00";
const VIEWPORT_BORDER_WIDTH = 2;

// In-iframe cache of axis thumbnails, keyed by `${layerId}|${axis}|${ch}`.
// Each entry carries the loaded image plus the channel's current color
// and enabled flag (sent by the parent via postMessage). Color/enabled
// can be updated without re-fetching the image via
// `thumbnail_channel_state` messages.
interface ThumbnailCacheEntry {
  img: HTMLImageElement;
  color: string; // CSS hex, e.g. "#ff8800"
  enabled: boolean;
}
const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
const thumbnailRerenderSubscribers = new Set<() => void>();
let thumbnailMessageHandlerInstalled = false;
let thumbnailContrast = 1;

function thumbnailCacheKey(layerId: string, axis: Orientation, channel: number): string {
  return `${layerId}|${axis}|${channel}`;
}

function notifyThumbnailSubscribers() {
  for (const cb of thumbnailRerenderSubscribers) cb();
}

function requestThumbnailReplay(): void {
  try {
    window.parent.postMessage({ type: "thumbnail_request" }, "*");
  } catch {
    // Cross-origin or detached parent — minimap stays in dark fallback.
  }
}

function ensureThumbnailMessageHandler(): void {
  if (thumbnailMessageHandlerInstalled) return;
  thumbnailMessageHandlerInstalled = true;
  // Kick a replay request at install time so the very first minimap
  // panel mount gets data even if the parent broadcast already happened
  // before this iframe loaded.
  requestThumbnailReplay();
  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data) return;

    if (data.type === "axis_thumbnail") {
      const { layerId, axis, channel, url, color, enabled } = data as {
        layerId: string;
        axis: Orientation;
        channel: number;
        url: string;
        color?: string;
        enabled?: boolean;
      };
      if (!layerId || !axis || typeof channel !== "number" || !url) return;
      const key = thumbnailCacheKey(layerId, axis, channel);
      if (thumbnailCache.has(key)) {
        // Refresh color/enabled in place; image already loaded.
        const entry = thumbnailCache.get(key)!;
        if (typeof color === "string") entry.color = color;
        if (typeof enabled === "boolean") entry.enabled = enabled;
        notifyThumbnailSubscribers();
        return;
      }
      const img = new Image();
      img.onload = () => {
        thumbnailCache.set(key, {
          img,
          color: typeof color === "string" ? color : "#ffffff",
          enabled: enabled !== false,
        });
        notifyThumbnailSubscribers();
      };
      img.onerror = () => {
        // Drop the placeholder; minimap stays in dark fallback for this channel.
      };
      img.src = url;
      return;
    }

    if (data.type === "thumbnail_channel_state") {
      const { layerId, channels } = data as {
        layerId: string;
        channels: { color: string; enabled: boolean }[];
      };
      if (!layerId || !Array.isArray(channels)) return;
      // Update color/enabled across every cached axis × channel for
      // this layer; images stay in place.
      for (let c = 0; c < channels.length; c++) {
        const cs = channels[c];
        for (const axis of ["xy", "xz", "zy"] as const) {
          const entry = thumbnailCache.get(thumbnailCacheKey(layerId, axis, c));
          if (!entry) continue;
          if (typeof cs?.color === "string") entry.color = cs.color;
          if (typeof cs?.enabled === "boolean") entry.enabled = cs.enabled;
        }
      }
      notifyThumbnailSubscribers();
      return;
    }

    if (data.type === "thumbnail_clear") {
      // Parent switched scenes — drop everything so we don't composite
      // the previous scene's thumbnails into the new scene's minimap.
      thumbnailCache.clear();
      notifyThumbnailSubscribers();
      return;
    }

    if (data.type === "thumbnail_contrast") {
      const { value } = data as { value: number };
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        thumbnailContrast = value;
        notifyThumbnailSubscribers();
      }
      return;
    }
  });
}

// Orientation labels match the actual horizontal × vertical axis order
// shown in the corresponding slice panel:
//   "xy" → X horizontal, Y vertical
//   "xz" → X horizontal, Z vertical
//   "zy" → Z horizontal, Y vertical
// (The X-normal panel is named "zy" rather than "yz" because "yz" would
// imply Y-horizontal × Z-vertical, which doesn't match what neuroglancer
// actually renders.)
type Orientation = "xy" | "xz" | "zy";

/**
 * Get orientation from viewport normal vector by snapping to the closest
 * principal plane. Picks the axis with the largest |normal| component, with
 * ties broken Z > Y > X (matches neuroglancer's default load orientation).
 * Returns null only if the normal is degenerate (all zeros / wrong length).
 *
 * - XY plane: normal closest to ±Z (looking down Z)
 * - XZ plane: normal closest to ±Y
 * - ZY plane: normal closest to ±X
 */
function getOrientationFromNormal(
  normal: Float32Array | number[],
): Orientation | null {
  if (!normal || normal.length < 3) return null;

  const a = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  if (a[0] === 0 && a[1] === 0 && a[2] === 0) return null;

  // Argmax with ties favoring later axes (Z > Y > X).
  let domAxis = 0;
  if (a[1] >= a[domAxis]) domAxis = 1;
  if (a[2] >= a[domAxis]) domAxis = 2;

  switch (domAxis) {
    case 0: // X-dominant normal → ZY panel
      return "zy";
    case 1: // Y-dominant normal → XZ panel
      return "xz";
    case 2: // Z-dominant normal → XY panel
      return "xy";
    default:
      return null;
  }
}

/**
 * Get dimension indices for an orientation.
 * Returns [horizontal, vertical] dimension indices in global coordinates.
 */
function getDimensionsForOrientation(orientation: Orientation): [number, number] {
  switch (orientation) {
    case "xy":
      return [0, 1]; // X horizontal, Y vertical
    case "xz":
      return [0, 2]; // X horizontal, Z vertical
    case "zy":
      return [2, 1]; // Z horizontal, Y vertical
    default:
      return [0, 1];
  }
}

/**
 * A minimap for a single slice view panel.
 */
class PanelMinimap extends RefCounted {
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private isDragging = false;
  private renderRAFId: number | null = null;
  // Lazy offscreen canvas used to tint each channel's grayscale MIP
  // before additive blending onto the main minimap canvas. Reused
  // across channels and renders to avoid per-frame allocations.
  private tinterCanvas: HTMLCanvasElement | null = null;
  // User-controlled long-axis size in CSS px, persisted in
  // localStorage. Adjusted by dragging the top-left corner handle.
  private longAxisSize = loadSavedSize();
  // Resize-drag bookkeeping. We track the starting size + cursor so we
  // can compute deltas without bouncing through the moving canvas
  // bounds during the drag.
  // Reference kept so we can remove on disposal if needed (currently
  // the container.remove() in disposed() takes care of children too).
  // @ts-expect-error stored for diagnostic / future cleanup use
  private resizeHandle: HTMLDivElement | null = null;
  private resizeStartSize = 0;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private isResizing = false;
  private onResizeMove = (e: MouseEvent) => this.handleResizeMove(e);
  private onResizeUp = (e: MouseEvent) => this.handleResizeUp(e);
  // Mirror updates from sibling panels' minimaps so they all stay the
  // same size — registered in the constructor.
  private resizeBroadcastCb = (size: number) => this.applySize(size);

  // Bound rerender callback used as our subscription handle.
  private thumbnailRerenderCb = () => this.scheduleRender();

  constructor(
    private viewer: Viewer,
    private panel: any, // SliceViewPanel (need .sliceView for projectionParameters)
    private panelElement: HTMLElement,
    private orientation: Orientation
  ) {
    super();
    this.createDOM();
    this.setupListeners();
    ensureThumbnailMessageHandler();
    thumbnailRerenderSubscribers.add(this.thumbnailRerenderCb);
    minimapResizeSubscribers.add(this.resizeBroadcastCb);
    // Request a replay every panel-mount: covers the case where the
    // parent already broadcast its initial batch before this minimap
    // existed (so messages were dropped) and also handles iframe
    // reloads where the in-memory cache was wiped.
    requestThumbnailReplay();
    this.scheduleRender();
  }

  private applySize(size: number) {
    const clamped = Math.min(
      MINIMAP_SIZE_MAX,
      Math.max(MINIMAP_SIZE_MIN, Math.round(size)),
    );
    if (clamped === this.longAxisSize) return;
    this.longAxisSize = clamped;
    this.updateCanvasSize();
    this.scheduleRender();
  }

  // Mouse-down on the resize handle. Capture starting state and start
  // tracking move/up on the document so dragging beyond the handle
  // bounds doesn't lose the gesture.
  private handleResizeDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    this.isResizing = true;
    this.container.classList.add("resizing");
    this.resizeStartSize = this.longAxisSize;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;
    document.addEventListener("mousemove", this.onResizeMove);
    document.addEventListener("mouseup", this.onResizeUp);
  };

  private handleResizeMove(e: MouseEvent) {
    if (!this.isResizing) return;
    e.preventDefault();
    // Handle is at the top-LEFT of a bottom-right-anchored minimap.
    // Dragging up or left grows the minimap; down or right shrinks it.
    // Use the larger of the two deltas so diagonal drags feel responsive.
    const dx = this.resizeStartX - e.clientX;
    const dy = this.resizeStartY - e.clientY;
    const delta = Math.max(dx, dy);
    const next = this.resizeStartSize + delta;
    const clamped = Math.min(
      MINIMAP_SIZE_MAX,
      Math.max(MINIMAP_SIZE_MIN, Math.round(next)),
    );
    if (clamped === this.longAxisSize) return;
    this.longAxisSize = clamped;
    saveSize(clamped);
    this.updateCanvasSize();
    this.scheduleRender();
    // Notify sibling minimaps so they all match.
    for (const cb of minimapResizeSubscribers) {
      if (cb !== this.resizeBroadcastCb) cb(clamped);
    }
  }

  private handleResizeUp(_e: MouseEvent) {
    if (!this.isResizing) return;
    this.isResizing = false;
    this.container.classList.remove("resizing");
    document.removeEventListener("mousemove", this.onResizeMove);
    document.removeEventListener("mouseup", this.onResizeUp);
  }

  private createDOM() {
    this.container = document.createElement("div");
    this.container.className = "neuroglancer-minimap";
    this.container.dataset.orientation = this.orientation;

    this.canvas = document.createElement("canvas");
    // Size will be set in updateCanvasSize()
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;

    // Resize handle (top-left). The minimap is bottom-right anchored,
    // so dragging the handle up/left grows it.
    const handle = document.createElement("div");
    handle.className = "neuroglancer-minimap-resize-handle";
    handle.title = "Drag to resize minimap";
    handle.addEventListener("mousedown", this.handleResizeDown);
    this.container.appendChild(handle);
    this.resizeHandle = handle;

    // Append to panel element
    this.panelElement.appendChild(this.container);

    // Initial size calculation
    this.updateCanvasSize();
  }

  private updateCanvasSize() {
    const longAxis = this.longAxisSize;
    const minShort = Math.max(8, Math.round(longAxis * MINIMAP_MIN_SHORT_RATIO));
    const bounds = this.getDatasetBounds();
    if (!bounds) {
      this.canvas.width = longAxis;
      this.canvas.height = longAxis;
      this.canvas.style.width = `${longAxis}px`;
      this.canvas.style.height = `${longAxis}px`;
      return;
    }

    const { width: dataW, height: dataH } = bounds;
    const aspectRatio = dataW / dataH;

    let canvasW: number;
    let canvasH: number;

    if (aspectRatio >= 1) {
      canvasW = longAxis;
      canvasH = Math.max(minShort, Math.round(longAxis / aspectRatio));
    } else {
      canvasH = longAxis;
      canvasW = Math.max(minShort, Math.round(longAxis * aspectRatio));
    }

    this.canvas.width = canvasW;
    this.canvas.height = canvasH;
    this.canvas.style.width = `${canvasW}px`;
    this.canvas.style.height = `${canvasH}px`;
  }

  private getDatasetBounds(): { width: number; height: number; hIdx: number; vIdx: number } | null {
    const space = this.viewer.coordinateSpace.value;
    if (!space.valid) return null;

    const bounds = space.bounds;
    if (!bounds || bounds.lowerBounds.length < 3 || bounds.upperBounds.length < 3) {
      return null;
    }

    // Use orientation to determine which dimensions to use
    const [hIdx, vIdx] = getDimensionsForOrientation(this.orientation);

    const width = bounds.upperBounds[hIdx] - bounds.lowerBounds[hIdx];
    const height = bounds.upperBounds[vIdx] - bounds.lowerBounds[vIdx];

    if (width <= 0 || height <= 0) return null;

    return { width, height, hIdx, vIdx };
  }

  private setupListeners() {
    // Position changes
    this.registerDisposer(
      this.viewer.position.changed.add(() => this.scheduleRender())
    );

    // Zoom changes
    this.registerDisposer(
      this.viewer.crossSectionScale.changed.add(() => this.scheduleRender())
    );

    // Coordinate space changes (bounds might update)
    this.registerDisposer(
      this.viewer.coordinateSpace.changed.add(() => {
        this.updateCanvasSize();
        this.scheduleRender();
      })
    );

    // Panel projection changes — fires on R/E rotation, panel resize, etc.
    // Without this, the rotated viewport indicator stays stale.
    const projParams = this.panel?.sliceView?.projectionParameters;
    if (projParams?.changed?.add) {
      this.registerDisposer(
        projParams.changed.add(() => this.scheduleRender())
      );
    }

    // Mouse interactions
    this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
    this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
    this.canvas.addEventListener("mouseup", this.onMouseUp.bind(this));
    this.canvas.addEventListener("mouseleave", this.onMouseUp.bind(this));
    this.canvas.addEventListener("click", this.onClick.bind(this));
  }

  private scheduleRender() {
    if (this.renderRAFId !== null) return;
    this.renderRAFId = requestAnimationFrame(() => {
      this.renderRAFId = null;
      this.render();
    });
  }

  private render() {
    const { ctx, canvas } = this;
    const { width, height } = canvas;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Dark background — also serves as fallback when no MIP is cached
    // for this orientation yet.
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, width, height);

    // Composite all cached axis thumbnails matching this panel's
    // orientation. Each channel's grayscale thumbnail is tinted with
    // the channel's color (multiply blend on a per-channel offscreen
    // canvas), then composited additively onto the minimap so multi-
    // channel fluorescence renders the same way it does in the viewer.
    const matching: ThumbnailCacheEntry[] = [];
    for (const [key, entry] of thumbnailCache) {
      if (entry.enabled === false) continue;
      if (key.split("|")[1] === this.orientation) {
        matching.push(entry);
      }
    }
    if (matching.length > 0) {
      const prevComposite = ctx.globalCompositeOperation;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalCompositeOperation = "lighter";
      // Slight alpha trim keeps overlapping channels from clipping to
      // pure white; tuned visually for typical 1–9 channel scenes.
      ctx.globalAlpha = Math.min(1, 1.4 / Math.max(1, matching.length));

      // Reuse a single offscreen canvas for tinting (sized to the
      // minimap canvas). For each channel: draw grayscale, then
      // multiply by the color, then drawImage onto the main canvas.
      let tinter = this.tinterCanvas;
      if (!tinter) {
        tinter = document.createElement("canvas");
        this.tinterCanvas = tinter;
      }
      if (tinter.width !== width || tinter.height !== height) {
        tinter.width = width;
        tinter.height = height;
      }
      const tctx = tinter.getContext("2d");
      if (tctx) {
        // Global brightness multiplier applied to the grayscale source
        // ONLY (not to the color fill, which would shift hue). CSS
        // filter is per-draw and resets between calls.
        const brightnessFilter =
          thumbnailContrast === 1
            ? "none"
            : `brightness(${thumbnailContrast})`;
        for (const entry of matching) {
          tctx.globalCompositeOperation = "source-over";
          tctx.clearRect(0, 0, width, height);
          tctx.filter = brightnessFilter;
          tctx.drawImage(entry.img, 0, 0, width, height);
          tctx.filter = "none";
          // `multiply` tints the grayscale source toward the color.
          tctx.globalCompositeOperation = "multiply";
          tctx.fillStyle = entry.color || "#ffffff";
          tctx.fillRect(0, 0, width, height);
          // Restore source for the next channel.
          tctx.globalCompositeOperation = "source-over";
          ctx.drawImage(tinter, 0, 0);
        }
      }

      ctx.globalCompositeOperation = prevComposite;
      ctx.globalAlpha = prevAlpha;
    }

    // Border for visibility
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    // Draw orientation label
    ctx.fillStyle = "#666";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(this.orientation.toUpperCase(), width - 4, 3);

    // Draw viewport indicator (rotated polygon if panel is rotated)
    const corners = this.calculateViewportCorners();
    if (corners) {
      ctx.beginPath();
      for (let i = 0; i < corners.length; i++) {
        const x = corners[i].x * width;
        const y = corners[i].y * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      ctx.fillStyle = VIEWPORT_COLOR + "22";
      ctx.fill();

      ctx.strokeStyle = VIEWPORT_COLOR;
      ctx.lineWidth = VIEWPORT_BORDER_WIDTH;
      ctx.stroke();
    }
  }

  /**
   * Compute the four corners of the viewport in normalized minimap coords.
   * The viewport rectangle is built in WORLD space using the panel's
   * screen-right/screen-up vectors (extracted from invViewMatrix), then
   * projected onto the minimap's two axes (hIdx, vIdx). This makes the
   * indicator rotate correctly when the panel is spun with R/E even though
   * the dataset bounding box stays in the global frame.
   */
  private calculateViewportCorners(): { x: number; y: number }[] | null {
    const boundsInfo = this.getDatasetBounds();
    if (!boundsInfo) return null;

    const space = this.viewer.coordinateSpace.value;
    const bounds = space.bounds;
    const { width: dataW, height: dataH, hIdx, vIdx } = boundsInfo;

    const pos = this.viewer.position.value;
    if (!pos || pos.length < 3) return null;

    const projParams = this.panel?.sliceView?.projectionParameters?.value;
    const invView = projParams?.invViewMatrix as Float32Array | undefined;

    // Panel size in render pixels (projParams.width/height are authoritative;
    // panelRect is a fallback if projection params aren't ready yet).
    const panelRect = this.panelElement.getBoundingClientRect();
    const panelW: number = projParams?.width ?? panelRect.width;
    const panelH: number = projParams?.height ?? panelRect.height;

    // mat4 is column-major. invViewMatrix columns 0/1 are the world-space
    // displacement vectors per panel-X / panel-Y pixel — they ALREADY include
    // the pixelSize / zoom scale (see SliceView.projectionParameters update in
    // sliceview/frontend.ts). So multiplying by panelW/2 and panelH/2 alone
    // gives the half-extents in world units, no extra pixelSize factor.
    let rightH: number;
    let rightV: number;
    let upH: number;
    let upV: number;

    if (invView && invView.length >= 16) {
      rightH = invView[hIdx];
      rightV = invView[vIdx];
      upH = invView[hIdx + 4];
      upV = invView[vIdx + 4];
    } else {
      // Fallback: assume axis-aligned panel and use crossSectionScale as
      // world-per-pixel (matches pre-rotation behavior).
      const zoom = this.viewer.crossSectionScale.value ?? 1;
      rightH = zoom;
      rightV = 0;
      upH = 0;
      upV = zoom;
    }

    const halfW = panelW / 2;
    const halfH = panelH / 2;

    const cx = pos[hIdx];
    const cy = pos[vIdx];
    const lowH = bounds.lowerBounds[hIdx];
    const lowV = bounds.lowerBounds[vIdx];

    const offsets: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    // The "zy" panel renders Z increasing right→left (post +π/2 Y
    // rotation in data_panel_layout). The MIP PNG was already flipped
    // along Z to compensate, so the indicator's horizontal also has to
    // mirror to stay aligned with the background.
    const flipH = this.orientation === "zy";
    const corners: { x: number; y: number }[] = [];
    for (const [sx, sy] of offsets) {
      const wH = cx + sx * halfW * rightH + sy * halfH * upH;
      const wV = cy + sx * halfW * rightV + sy * halfH * upV;
      const nx = (wH - lowH) / dataW;
      corners.push({
        x: flipH ? 1 - nx : nx,
        y: (wV - lowV) / dataH,
      });
    }
    return corners;
  }


  private onClick(e: MouseEvent) {
    if (this.isDragging) return;

    const rect = this.canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    this.navigateTo(nx, ny);
  }

  private onMouseDown(e: MouseEvent) {
    this.isDragging = true;
    this.container.classList.add("dragging");
    e.preventDefault();
    e.stopPropagation();
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return;

    const rect = this.canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    this.navigateTo(nx, ny);
    e.preventDefault();
  }

  private onMouseUp(_e: MouseEvent) {
    this.isDragging = false;
    this.container.classList.remove("dragging");
  }

  private navigateTo(nx: number, ny: number) {
    const boundsInfo = this.getDatasetBounds();
    if (!boundsInfo) return;

    const space = this.viewer.coordinateSpace.value;
    const bounds = space.bounds;
    const { width: dataW, height: dataH, hIdx, vIdx } = boundsInfo;

    // Match the indicator: "zy" panel has Z mirrored on screen, so a
    // click at canvas-x = nx maps to world Z = (1 - nx) * dataW.
    const effectiveNx = this.orientation === "zy" ? 1 - nx : nx;
    const newH = bounds.lowerBounds[hIdx] + effectiveNx * dataW;
    const newV = bounds.lowerBounds[vIdx] + ny * dataH;

    // Update position (keep other dimension unchanged)
    const pos = this.viewer.position.value.slice();
    pos[hIdx] = newH;
    pos[vIdx] = newV;
    this.viewer.position.value = new Float32Array(pos);
  }

  getContainer(): HTMLDivElement {
    return this.container;
  }

  getOrientation(): Orientation {
    return this.orientation;
  }

  setVisible(visible: boolean) {
    if (visible) {
      this.container.classList.remove("hidden");
    } else {
      this.container.classList.add("hidden");
    }
  }

  disposed() {
    if (this.renderRAFId !== null) {
      cancelAnimationFrame(this.renderRAFId);
    }
    thumbnailRerenderSubscribers.delete(this.thumbnailRerenderCb);
    minimapResizeSubscribers.delete(this.resizeBroadcastCb);
    if (this.isResizing) {
      document.removeEventListener("mousemove", this.onResizeMove);
      document.removeEventListener("mouseup", this.onResizeUp);
    }
    this.container.remove();
    super.disposed();
  }
}

/**
 * Manager for all panel minimaps.
 */
export class MinimapOverlay extends RefCounted {
  private panelMinimaps: Map<HTMLElement, PanelMinimap> = new Map();
  private enabled = true;
  private orientationEnabled: Map<Orientation, boolean> = new Map([
    ["xy", true],
    ["xz", true],
    ["zy", true],
  ]);
  private mutationObserver: MutationObserver | null = null;
  private updateDebounceId: number | null = null;

  constructor(private viewer: Viewer) {
    super();
    this.setupPanelObserver();
    this.updateMinimaps();
  }

  private setupPanelObserver() {
    // Watch for panel changes (layout changes, etc.)
    const container = this.viewer.display.container as HTMLElement;

    this.mutationObserver = new MutationObserver(() => {
      this.scheduleUpdate();
    });

    this.mutationObserver.observe(container, {
      childList: true,
      subtree: true,
    });
  }

  private scheduleUpdate() {
    if (this.updateDebounceId !== null) {
      clearTimeout(this.updateDebounceId);
    }
    this.updateDebounceId = window.setTimeout(() => {
      this.updateDebounceId = null;
      this.updateMinimaps();
    }, 100);
  }

  private updateMinimaps() {
    if (!this.enabled) return;

    const panels = this.getSliceViewPanels();
    const currentPanelElements = new Set<HTMLElement>();

    // Add minimaps for new panels
    for (const { element, panel, orientation } of panels) {
      currentPanelElements.add(element);

      if (!this.panelMinimaps.has(element)) {
        const minimap = new PanelMinimap(this.viewer, panel, element, orientation);
        this.panelMinimaps.set(element, minimap);
      }
    }

    // Remove minimaps for panels that no longer exist
    for (const [element, minimap] of this.panelMinimaps) {
      if (!currentPanelElements.has(element)) {
        minimap.dispose();
        this.panelMinimaps.delete(element);
      }
    }

    // Apply visibility based on orientation settings
    this.applyOrientationVisibility();
  }

  private getSliceViewPanels(): { element: HTMLElement; panel: any; orientation: Orientation }[] {
    const results: { element: HTMLElement; panel: any; orientation: Orientation }[] = [];

    if (!this.viewer?.display?.panels) return results;

    for (const panel of this.viewer.display.panels) {
      // Cast to any to access sliceView property (only exists on SliceViewPanel)
      const panelAny = panel as any;

      // SliceView panels have a sliceView property
      if (!panelAny?.sliceView) continue;

      const element = panel.element as HTMLElement;
      if (!element) continue;

      // Get orientation from viewport normal vector
      // The viewport normal tells us which direction is "into the screen"
      const projParams = panelAny.sliceView?.projectionParameters?.value;
      if (!projParams?.viewportNormalInCanonicalCoordinates) continue;

      const orientation = getOrientationFromNormal(projParams.viewportNormalInCanonicalCoordinates);
      if (!orientation) continue;

      results.push({ element, panel: panelAny, orientation });
    }

    return results;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.updateMinimaps();
    }
    this.applyOrientationVisibility();
  }

  setThumbnail(_url: string) {
    // Thumbnails not needed - using plain background
  }

  /**
   * Toggle visibility for a specific orientation (xy, xz, yz).
   */
  setOrientationEnabled(orientation: Orientation, enabled: boolean) {
    this.orientationEnabled.set(orientation, enabled);
    this.applyOrientationVisibility();
  }

  /**
   * Get current visibility state for an orientation.
   */
  isOrientationEnabled(orientation: Orientation): boolean {
    return this.orientationEnabled.get(orientation) ?? true;
  }

  /**
   * Get visibility state for all orientations.
   */
  getOrientationState(): { xy: boolean; xz: boolean; zy: boolean } {
    return {
      xy: this.orientationEnabled.get("xy") ?? true,
      xz: this.orientationEnabled.get("xz") ?? true,
      zy: this.orientationEnabled.get("zy") ?? true,
    };
  }

  private applyOrientationVisibility() {
    for (const minimap of this.panelMinimaps.values()) {
      const orientation = minimap.getOrientation();
      const orientationVisible = this.orientationEnabled.get(orientation) ?? true;
      const visible = this.enabled && orientationVisible;
      minimap.setVisible(visible);
    }
  }

  disposed() {
    if (this.updateDebounceId !== null) {
      clearTimeout(this.updateDebounceId);
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }
    for (const minimap of this.panelMinimaps.values()) {
      minimap.dispose();
    }
    this.panelMinimaps.clear();
    super.disposed();
  }
}

// Singleton instance per viewer
let minimapInstance: MinimapOverlay | null = null;

export function initMinimap(viewer: Viewer): MinimapOverlay {
  if (minimapInstance) {
    minimapInstance.dispose();
  }
  minimapInstance = new MinimapOverlay(viewer);
  return minimapInstance;
}

export function getMinimap(): MinimapOverlay | null {
  return minimapInstance;
}
