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
 * The "soft" form of `invalidate_chunks`. The page asks the viewer to read ONE
 * layer again without emptying it, and the viewer answers with
 * `layer_reloaded` once the layer shows the new data. In the frame that
 * shows the new data it also hides the draft layer, which would otherwise be
 * drawn over the committed layer (brighter than either) for as long as the
 * page takes to remove it.
 *
 * The page keeps the draft's strokes in place while it waits for this answer,
 * so nothing is lost if the answer never comes: the page has a timer of its
 * own, and `DraftHider` shows the draft again after a safety time.
 */

import type { ChunkSourceRefreshResult } from "#src/chunk_manager/base.js";

export type RefreshResult = ChunkSourceRefreshResult;

/** The part of a managed layer that hiding the draft uses. */
export interface LayerLike {
  name: string;
  visible: boolean;
  setVisible(value: boolean): void;
}

/** The part of a chunk source that a soft refresh uses. */
export interface SourceLike {
  refreshCache(): Promise<RefreshResult>;
  invalidateCache(): void;
}

interface RenderLayerLike {
  userLayer?: { managedLayer?: { name: string } } | undefined;
}

interface PanelLike {
  sliceView?: {
    visibleLayerList: readonly RenderLayerLike[];
    visibleLayers: {
      get(
        renderLayer: RenderLayerLike,
      ):
        | { allSources: readonly (readonly { source: SourceLike }[])[] }
        | undefined;
    };
  };
}

export interface LayerManagerLike {
  getLayerByName(name: string): LayerLike | undefined;
  layersChanged: { add(handler: () => void): () => void };
}

export interface ViewerLike {
  display: { panels: Iterable<PanelLike>; scheduleRedraw(): void };
  layerManager: LayerManagerLike;
  chunkQueueManager: { flushPendingChunkUpdates(): number };
}

/** How long the viewer waits for the sources of a soft refresh before it answers without them. */
export const SOFT_REFRESH_TIMEOUT_MS = 8000;

export interface SoftInvalidateMessage {
  /** The layer whose data changed. */
  layerName: string;
  /** Which commit this is, so the page can tell which hold the answer ends. */
  commitId: string;
  /** The draft layer to hide once `layerName` shows the new data. */
  hideLayerName?: string;
}

export interface RefreshReply {
  type: "layer_reloaded";
  layerName: string;
  commitId: string;
  /** Every source was refreshed in place, so the layer shows the new data. */
  ok: boolean;
  refreshed: number;
  failed: number;
  timedOut: boolean;
  /** The draft layer was hidden in the same frame as the new data. */
  hidden: boolean;
}

export interface SoftInvalidateEnv {
  post(reply: RefreshReply): void;
  /** Resolves once the frame that shows the new data has been drawn. */
  frames(): Promise<void>;
  /** How long to wait for the sources before answering without them. */
  timeoutMs: number;
}

/** The chunk sources that draw `layerName` in any of the viewer's slice views. */
export function findLayerSources(
  viewer: ViewerLike,
  layerName: string,
): SourceLike[] {
  const found = new Set<SourceLike>();
  for (const panel of viewer.display.panels) {
    const { sliceView } = panel;
    if (sliceView === undefined) continue;
    for (const renderLayer of sliceView.visibleLayerList) {
      if (renderLayer.userLayer?.managedLayer?.name !== layerName) continue;
      const info = sliceView.visibleLayers.get(renderLayer);
      for (const scale of info?.allSources ?? []) {
        for (const { source } of scale) {
          found.add(source);
        }
      }
    }
  }
  return [...found];
}

/**
 * Refreshes every source of `message.layerName` in place, puts the result on
 * screen, hides the draft layer in the same step, and answers.
 *
 * The draft is hidden only when every source was refreshed in place and there
 * was a source to refresh: the draft is the only thing that shows the stroke
 * until the layer does. A source that refuses the soft refresh is invalidated
 * the old way, so it empties and fills again as it always did.
 */
export async function handleSoftInvalidate(
  viewer: ViewerLike,
  message: SoftInvalidateMessage,
  env: SoftInvalidateEnv,
  hider: DraftHider,
): Promise<void> {
  const { layerName, commitId, hideLayerName } = message;
  const sources = findLayerSources(viewer, layerName);

  let refreshed = 0;
  let failed = 0;
  // Whether every source was refreshed in place.
  let inPlace = true;
  let timedOut = false;

  const refreshing = Promise.all(
    sources.map(async (source) => {
      try {
        const result = await source.refreshCache();
        refreshed += result.refreshed;
        failed += result.failed;
        if (result.failed > 0 || result.fellBack) inPlace = false;
      } catch {
        ++failed;
        inPlace = false;
        source.invalidateCache();
      }
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, env.timeoutMs);
  });
  await Promise.race([refreshing, timeout]);
  clearTimeout(timer);

  // Put every replacement that has arrived on screen. A refresh that is still
  // running when this gives up is not cancelled: its chunks arrive later and
  // are drawn as they come.
  viewer.chunkQueueManager.flushPendingChunkUpdates();
  const ok = inPlace && !timedOut;
  let hidden = false;
  if (ok && sources.length > 0 && hideLayerName !== undefined) {
    hidden = hider.hide(hideLayerName);
  }
  viewer.display.scheduleRedraw();
  await env.frames();
  env.post({
    type: "layer_reloaded",
    layerName,
    commitId,
    ok,
    refreshed,
    failed,
    timedOut,
    hidden,
  });
}

/**
 * Hides the draft layer, and makes sure it does not stay hidden.
 *
 * The page removes the draft when it ends the hold, which gives the viewer a
 * new draft layer; that one is visible by default. If the page never ends the
 * hold, the safety timer shows the same layer again. A layer that was replaced
 * or removed in the meantime is forgotten, never touched by the old timer.
 */
export class DraftHider {
  private hidden = new Map<
    string,
    { layer: LayerLike; timer: ReturnType<typeof setTimeout> }
  >();
  private stopListening: () => void;

  constructor(
    private layerManager: LayerManagerLike,
    /** Longer than the server's own limit on a hold, so that it is not the first to give up. */
    private safetyMs = 20_000,
  ) {
    this.stopListening = layerManager.layersChanged.add(() => this.check());
  }

  /** Hides `name`. False when there is no such layer, or it was hidden already. */
  hide(name: string): boolean {
    const layer = this.layerManager.getLayerByName(name);
    if (layer === undefined) return false;
    const hiddenHere = this.hidden.get(name)?.layer === layer;
    this.forget(name);
    // A layer the user has hidden is theirs: it is neither hidden here nor shown later.
    if (!layer.visible && !hiddenHere) return false;
    layer.setVisible(false);
    const timer = setTimeout(() => {
      if (this.hidden.get(name)?.layer !== layer) return;
      this.hidden.delete(name);
      layer.setVisible(true);
    }, this.safetyMs);
    this.hidden.set(name, { layer, timer });
    return true;
  }

  dispose() {
    this.stopListening();
    for (const { timer } of this.hidden.values()) {
      clearTimeout(timer);
    }
    this.hidden.clear();
  }

  private forget(name: string) {
    const entry = this.hidden.get(name);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.hidden.delete(name);
  }

  /** A layer that is not the one hidden any more has been replaced or removed. */
  private check() {
    for (const [name, { layer }] of this.hidden) {
      const current = this.layerManager.getLayerByName(name);
      if (current === layer) continue;
      this.forget(name);
      // The replacement is visible unless the hide was copied into it by the
      // page's own state; it was never hidden on purpose.
      if (current !== undefined && !current.visible) current.setVisible(true);
    }
  }
}

/**
 * Resolves after `count` animation frames, or after `fallbackMs` when frames
 * are not being drawn (a hidden tab).
 */
export function animationFrames(count: number, fallbackMs: number) {
  return new Promise<void>((resolve) => {
    let left = count;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const tick = () => {
      if (--left <= 0) {
        finish();
      } else {
        requestAnimationFrame(tick);
      }
    };
    timer = setTimeout(finish, fallbackMs);
    requestAnimationFrame(tick);
  });
}
