import "#src/custom/minimap.css";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

const MAX_MINIMAP_SIZE = 120;
const MIN_MINIMAP_SIZE = 40;
const VIEWPORT_COLOR = "#ffcc00";
const VIEWPORT_BORDER_WIDTH = 2;

type Orientation = "xy" | "xz" | "yz";

/**
 * Get orientation from viewport normal vector.
 * The viewport normal tells us which direction is "into the screen":
 * - XY plane: normal is (0, 0, ±1) - looking along Z axis
 * - XZ plane: normal is (0, ±1, 0) - looking along Y axis
 * - YZ plane: normal is (±1, 0, 0) - looking along X axis
 */
function getOrientationFromNormal(normal: Float32Array | number[]): Orientation | null {
  if (!normal || normal.length < 3) return null;

  const absX = Math.abs(normal[0]);
  const absY = Math.abs(normal[1]);
  const absZ = Math.abs(normal[2]);

  // Find which component is dominant (closest to 1)
  if (absZ > absX && absZ > absY) {
    // Looking along Z axis -> XY plane
    return "xy";
  } else if (absY > absX && absY > absZ) {
    // Looking along Y axis -> XZ plane
    return "xz";
  } else if (absX > absY && absX > absZ) {
    // Looking along X axis -> YZ plane
    return "yz";
  }

  return null;
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
    case "yz":
      return [2, 1]; // Z horizontal, Y vertical (rotated 90°)
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

  constructor(
    private viewer: Viewer,
    _panel: any, // Kept for potential future use
    private panelElement: HTMLElement,
    private orientation: Orientation
  ) {
    super();
    this.createDOM();
    this.setupListeners();
    this.scheduleRender();
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

    // Append to panel element
    this.panelElement.appendChild(this.container);

    // Initial size calculation
    this.updateCanvasSize();
  }

  private updateCanvasSize() {
    const bounds = this.getDatasetBounds();
    if (!bounds) {
      this.canvas.width = MAX_MINIMAP_SIZE;
      this.canvas.height = MAX_MINIMAP_SIZE;
      return;
    }

    const { width: dataW, height: dataH } = bounds;
    const aspectRatio = dataW / dataH;

    let canvasW: number;
    let canvasH: number;

    if (aspectRatio >= 1) {
      // Wider than tall
      canvasW = MAX_MINIMAP_SIZE;
      canvasH = Math.max(MIN_MINIMAP_SIZE, Math.round(MAX_MINIMAP_SIZE / aspectRatio));
    } else {
      // Taller than wide
      canvasH = MAX_MINIMAP_SIZE;
      canvasW = Math.max(MIN_MINIMAP_SIZE, Math.round(MAX_MINIMAP_SIZE * aspectRatio));
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

    // Dark background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, width, height);

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

    // Draw viewport indicator
    const viewport = this.calculateViewport();
    if (viewport) {
      const x = viewport.x * width;
      const y = viewport.y * height;
      const w = viewport.w * width;
      const h = viewport.h * height;

      // Semi-transparent fill
      ctx.fillStyle = VIEWPORT_COLOR + "22";
      ctx.fillRect(x, y, w, h);

      // Border
      ctx.strokeStyle = VIEWPORT_COLOR;
      ctx.lineWidth = VIEWPORT_BORDER_WIDTH;
      ctx.strokeRect(x, y, w, h);
    }
  }

  private calculateViewport(): { x: number; y: number; w: number; h: number } | null {
    const boundsInfo = this.getDatasetBounds();
    if (!boundsInfo) return null;

    const space = this.viewer.coordinateSpace.value;
    const bounds = space.bounds;
    const { width: dataW, height: dataH, hIdx, vIdx } = boundsInfo;

    // Current position (center of view)
    const pos = this.viewer.position.value;
    if (!pos || pos.length < 3) return null;

    // Get zoom level (voxels per screen pixel)
    const zoom = this.viewer.crossSectionScale.value;

    // Get panel size for visible extent calculation
    const panelRect = this.panelElement.getBoundingClientRect();
    const visibleW = panelRect.width * zoom;
    const visibleH = panelRect.height * zoom;

    // Normalize to [0-1]
    const centerX = (pos[hIdx] - bounds.lowerBounds[hIdx]) / dataW;
    const centerY = (pos[vIdx] - bounds.lowerBounds[vIdx]) / dataH;
    const normW = Math.min(1, visibleW / dataW);
    const normH = Math.min(1, visibleH / dataH);

    return {
      x: Math.max(0, Math.min(1 - normW, centerX - normW / 2)),
      y: Math.max(0, Math.min(1 - normH, centerY - normH / 2)),
      w: normW,
      h: normH,
    };
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

    const newH = bounds.lowerBounds[hIdx] + nx * dataW;
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
    ["yz", true],
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
  getOrientationState(): { xy: boolean; xz: boolean; yz: boolean } {
    return {
      xy: this.orientationEnabled.get("xy") ?? true,
      xz: this.orientationEnabled.get("xz") ?? true,
      yz: this.orientationEnabled.get("yz") ?? true,
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
