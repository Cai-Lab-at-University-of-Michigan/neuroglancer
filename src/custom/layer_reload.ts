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
 * Every message gets exactly one answer. `ok` says the layer shows the new
 * data: anything else (a read failed, the sources took too long, a newer
 * refresh took over, something broke) is `ok: false`, and the page then keeps
 * the draft's strokes in place until its own timer. A message that cannot be
 * served here (no source of that name in the viewer) is answered `ok: false`
 * and left to the whole-layer invalidation.
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
  refreshCache(signal?: AbortSignal): Promise<RefreshResult>;
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
  chunkQueueManager: { beginRefreshHold(): void; endRefreshHold(): number };
}

/** How long the viewer waits for the sources of a soft refresh before it answers without them. */
export const SOFT_REFRESH_TIMEOUT_MS = 8000;

/**
 * How long a soft refresh may run before its reads are cancelled. Past the
 * answer at 8 s the reads go on (late chunks are still wanted); this only
 * frees the read slots from a fetch that is stuck.
 */
export const SOFT_REFRESH_ABORT_AFTER_MS = 60_000;

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
  /** How long the reads may run before they are cancelled. */
  abortAfterMs: number;
}

/**
 * The fields of a soft `invalidate_chunks` message, or nothing when the
 * message does not ask for one (the whole-layer invalidation takes it then).
 */
export function softInvalidateRequest(
  data: unknown,
): SoftInvalidateMessage | undefined {
  const fields = data as
    | {
        soft?: unknown;
        layerName?: unknown;
        commitId?: unknown;
        hideLayerName?: unknown;
      }
    | null
    | undefined;
  if (
    fields?.soft !== true ||
    typeof fields.layerName !== "string" ||
    typeof fields.commitId !== "string"
  ) {
    return undefined;
  }
  const message: SoftInvalidateMessage = {
    layerName: fields.layerName,
    commitId: fields.commitId,
  };
  if (typeof fields.hideLayerName === "string") {
    message.hideLayerName = fields.hideLayerName;
  }
  return message;
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
 * The refreshes that are running, one per layer. A newer refresh of a layer
 * cancels the older one, whose reads are then of no use (the newer one reads
 * the same chunks), and a refresh is cancelled after a hard limit so that a
 * stuck read does not hold one of the worker's read slots for good.
 */
export class RunningRefreshes {
  private running = new Map<string, AbortController>();

  begin(layerName: string, abortAfterMs: number) {
    const older = this.running.get(layerName);
    const controller = new AbortController();
    this.running.set(layerName, controller);
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException("the refresh took too long", "TimeoutError"),
      );
    }, abortAfterMs);
    return {
      signal: controller.signal,
      /**
       * Cancels the refresh of this layer that was running when this one began.
       * Call it once the reads of this refresh have been asked for: the worker
       * then sees this refresh begin before it sees the older one cancelled,
       * so the older one knows it was taken over and does not drop the chunks
       * this one is about to read.
       */
      cancelOlder: () => {
        older?.abort(
          new DOMException(
            "a newer refresh of this layer started",
            "AbortError",
          ),
        );
      },
      /** The reads are over: stop the limit, and forget this refresh. */
      finish: () => {
        clearTimeout(timer);
        if (this.running.get(layerName) === controller) {
          this.running.delete(layerName);
        }
      },
    };
  }
}

function replyFor(
  message: SoftInvalidateMessage,
  fields: Partial<RefreshReply>,
): RefreshReply {
  return {
    type: "layer_reloaded",
    layerName: message.layerName,
    commitId: message.commitId,
    ok: false,
    refreshed: 0,
    failed: 0,
    timedOut: false,
    hidden: false,
    ...fields,
  };
}

/**
 * Starts the soft refresh of `message.layerName`. False, after telling the
 * page it got none (`ok: false`), when no slice view draws a layer of that name
 * (the layer was renamed in the viewer, or the scene gave it a " (2)" suffix):
 * the caller then invalidates the whole layer the old way, which finds the
 * layer by its type and not by its name.
 */
export function startSoftInvalidate(
  viewer: ViewerLike,
  message: SoftInvalidateMessage,
  env: SoftInvalidateEnv,
  hider: DraftHider,
  running = new RunningRefreshes(),
): boolean {
  if (findLayerSources(viewer, message.layerName).length === 0) {
    env.post(replyFor(message, {}));
    return false;
  }
  handleSoftInvalidate(viewer, message, env, hider, running).catch((err) => {
    console.error("[invalidate_chunks] soft refresh failed:", err);
  });
  return true;
}

/**
 * Refreshes every source of `message.layerName` in place, puts the result on
 * screen, hides the draft layer in the same step, and answers.
 *
 * The draft is hidden only when every source was refreshed in place: the draft
 * is the only thing that shows the stroke until the layer does. A source that
 * refuses the soft refresh is invalidated the old way, so it empties and fills
 * again as it always did; a refresh that was cancelled on purpose is not.
 */
export async function handleSoftInvalidate(
  viewer: ViewerLike,
  message: SoftInvalidateMessage,
  env: SoftInvalidateEnv,
  hider: DraftHider,
  running = new RunningRefreshes(),
): Promise<void> {
  const { layerName, hideLayerName } = message;
  let refreshed = 0;
  let failed = 0;
  let timedOut = false;
  let hidden = false;
  // The page waits for one answer to every message. Whatever goes wrong
  // below, it gets that one, and it says ok: false.
  let answered = false;
  const answer = (ok: boolean) => {
    if (answered) return;
    answered = true;
    env.post(replyFor(message, { ok, refreshed, failed, timedOut, hidden }));
  };

  let refresh: ReturnType<RunningRefreshes["begin"]> | undefined;
  let reading: Promise<unknown> | undefined;
  try {
    const sources = findLayerSources(viewer, layerName);
    if (sources.length === 0) {
      answer(false);
      return;
    }
    // The draft as it is now. If the page rebuilds it before the layer shows
    // the new data (the user started drawing again), the layer of that name
    // holds the next stroke and is left alone.
    const draft =
      hideLayerName === undefined
        ? undefined
        : viewer.layerManager.getLayerByName(hideLayerName);
    // Whether every source was refreshed in place.
    let inPlace = true;
    refresh = running.begin(layerName, env.abortAfterMs);
    const { signal } = refresh;

    // The replacements are kept back until every source has answered, so that
    // they appear together, in the frame that hides the draft.
    let holding = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      viewer.chunkQueueManager.beginRefreshHold();
      holding = true;
      reading = Promise.all(
        sources.map(async (source) => {
          try {
            const result = await source.refreshCache(signal);
            refreshed += result.refreshed;
            failed += result.failed;
            if (result.failed > 0 || result.fellBack || result.superseded) {
              inPlace = false;
            }
          } catch {
            ++failed;
            inPlace = false;
            // A refresh cancelled on purpose is no reason to empty the
            // source: a newer refresh is filling it, or the read was stuck.
            if (!signal.aborted) {
              try {
                source.invalidateCache();
              } catch (err) {
                console.error("[invalidate_chunks] could not invalidate", err);
              }
            }
          }
        }),
      );
      // Every read of this refresh has been asked for, so the older refresh of
      // the layer, if there is one, can go.
      refresh.cancelOlder();
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, env.timeoutMs);
      });
      await Promise.race([reading, timeout]);
    } finally {
      clearTimeout(timer);
      // Put every replacement that has arrived on screen. A refresh that is
      // still running when this gives up is not cancelled: its chunks arrive
      // later and are drawn as they come.
      if (holding) viewer.chunkQueueManager.endRefreshHold();
    }

    // Ok means the layer shows the new data: nothing failed or took too long,
    // the refresh was not cancelled, and it replaced something. A refresh that
    // replaced nothing found no chunk of the layer on screen, and hiding the
    // draft would leave the stroke on nothing until the layer has loaded.
    const ok = inPlace && !timedOut && !signal.aborted && refreshed > 0;
    if (ok && hideLayerName !== undefined && draft) {
      hidden = hider.hide(hideLayerName, draft);
    }
    viewer.display.scheduleRedraw();
    await env.frames();
    answer(ok);
  } catch (err) {
    console.error("[invalidate_chunks] soft refresh failed:", err);
    answer(false);
  } finally {
    // The limit on the reads and the entry for this refresh live as long as
    // the reads do (a refresh that gave up waiting keeps reading).
    if (refresh !== undefined) {
      if (reading === undefined) {
        refresh.finish();
      } else {
        const { finish } = refresh;
        reading.then(finish, finish);
      }
    }
  }
}

/**
 * Hides the draft layer, and makes sure it does not stay hidden.
 *
 * The page removes the draft when it ends the hold, which rebuilds the
 * layers, and the rebuilt draft is visible by default. That is what shows the
 * draft again in SAVAII, and a layer that was replaced or removed in the
 * meantime is forgotten here, never touched by the old record. The safety
 * timer is for a viewer whose page never ends the hold and never rebuilds
 * the layers: it shows the same layer again.
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

  /**
   * Hides `name`. False when there is no such layer, it is not `expected`
   * (when that is given), or it was hidden already.
   */
  hide(name: string, expected?: LayerLike): boolean {
    const layer = this.layerManager.getLayerByName(name);
    if (layer === undefined) return false;
    if (expected !== undefined && layer !== expected) return false;
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
    const timer = setTimeout(finish, fallbackMs);
    requestAnimationFrame(tick);
  });
}

/** The page the viewer is embedded in, as `handleSoftInvalidate` needs it. */
export function pageEnv(): SoftInvalidateEnv {
  return {
    post: (reply) => window.parent.postMessage(reply, "*"),
    frames: () => animationFrames(2, 250),
    timeoutMs: SOFT_REFRESH_TIMEOUT_MS,
    abortAfterMs: SOFT_REFRESH_ABORT_AFTER_MS,
  };
}
