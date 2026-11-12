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
 * A user's unsaved edits of a segmentation layer (the draft) live in the
 * backend. The backend has a route that answers a chunk of the layer with the
 * draft laid over the saved data, so the viewer keeps drawing ONE layer: a
 * chunk the draft may cover is read from that route, every other chunk from
 * the CDN as before.
 *
 * The page tells the viewer what the draft covers with three messages:
 *   draft_state     the whole draft: its generation and the regions it
 *                   touches. Safe to send again: a repeat does nothing.
 *   draft_changed   what one write, undo or redo changed.
 *   draft_released  a Save put these regions into the layer.
 * The messages carry no voxels. Everything here is kept in the chunk worker's
 * memory, per layer, and can be rebuilt from a draft_state at any time; none
 * of it goes into the layer's JSON state.
 *
 * A viewer that has received none of these messages reads every chunk from
 * the CDN, exactly as it did before this file existed.
 */

import { fetchOk, HttpError } from "#src/util/http_request.js";

/** Levels the draft route serves: the scale keys of a segmentation layer. */
const LEVELS = [1, 2, 4, 8, 16];
/** Side of a draft region, in voxels of level 1. */
const REGION_VOXELS = 128;
/** Side of a changed key, in voxels of its own level. */
const KEY_VOXELS = 32;
/**
 * The draft route computes a chunk coarser than this from level 1 on every
 * request (nothing coarse is stored), so such a chunk is read only when a
 * view shows it, never ahead of time.
 */
const PREFETCH_MAX_LEVEL = 4;
/**
 * How long an answer that is newer than the last message waits for that
 * message before the viewer asks for the whole state. A write's answers can
 * reach the worker before its message does; that is no loss.
 */
const BEHIND_WAIT_MS = 1000;
/** The route's ways of saying "not for you": no sign-in, no access, another user. */
const REFUSALS = new Set([401, 403, 404, 409]);

export const DRAFT_UPDATE_RPC_ID = "Draft.update";
export const DRAFT_NOTICE_RPC_ID = "Draft.notice";

/** Cubes of `cell` voxels a side, by their z, y, x index. */
export interface CellSet {
  cell: number;
  keys: Set<number>;
}

interface LayerFields {
  /** The layer's item id, handed back to the page with every notice. */
  layerItemId: string;
  /** The layer's path on the CDN: how the worker finds the layer's sources. */
  location: string;
}

export type DraftMessage =
  | (LayerFields & {
      kind: "state";
      /** The chunk route, up to and including `/chunk`. */
      base: string;
      generation: number;
      /** The 128^3 regions [z, y, x] the draft holds something in. */
      regions: number[][];
    })
  | (LayerFields & {
      kind: "changed";
      base: string;
      generation: number;
      /** The generation before this change. */
      prev: number;
      /** Level -> the 32^3 keys [z, y, x] of that level that may look different. */
      changed: Record<string, number[][]>;
    })
  | (LayerFields & {
      kind: "released";
      generation: number;
      prev: number;
      /** Regions the draft held before the Save and no longer holds. */
      regions: number[][];
    });

export type DraftNotice = LayerFields &
  ({ kind: "behind"; have: number } | { kind: "refused"; status: number });

export interface DraftRoute extends LayerFields {
  base: string;
  /** The newest generation the page has told this viewer about. */
  generation: number;
  /** Regions the draft may hold something in. */
  touched: Set<number>;
  /** The newest generation seen on an answer, while it is ahead of `generation`. */
  ahead: number;
  aheadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Refusals the page has been told about since the last draft_state. */
  refused: Set<number>;
  /** The last draft_state was older than `generation` and was left alone. */
  olderStateSeen: boolean;
}

export interface DraftApplied {
  /** An older copy or a duplicate: nothing was done. */
  ignored: boolean;
  /** The message does not follow the generation the viewer had: one was lost. */
  gap: boolean;
  /** A draft_state older than what the viewer has was left alone: ask again. */
  older: boolean;
  /** The generation the viewer had before this message. */
  have: number;
  /** Level -> what to read again at that level. */
  refresh: Map<number, CellSet>;
}

const KEY_BASE = 2 ** 17;

function trimSlashes(text: string) {
  return text.replace(/\/+$/, "");
}

/** `.../<layer>/<level>/`, the URL of one scale of a precomputed volume. */
export function parseScaleUrl(url: string | undefined) {
  if (url === undefined) return undefined;
  const match = /^(.*)\/(\d+)\/?$/.exec(url);
  if (match === null) return undefined;
  return { layer: match[1], level: Number(match[2]) };
}

/** Whether `layerUrl` is the layer a message's `location` names: its whole URL, or the end of it. */
function isLayerAt(layerUrl: string, location: string) {
  const path = trimSlashes(location);
  return layerUrl === path || layerUrl.endsWith(`/${path}`);
}

/**
 * Whether the box at `pos` (x, y, z) of `size` shares a voxel with a cell of
 * the set.
 */
export function meets(
  cells: CellSet,
  pos: ArrayLike<number>,
  size: ArrayLike<number>,
) {
  const { cell, keys } = cells;
  if (keys.size === 0) return false;
  const lo = [0, 1, 2].map((i) => Math.floor(pos[i] / cell));
  const hi = [0, 1, 2].map((i) => Math.floor((pos[i] + size[i] - 1) / cell));
  const inBox = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  if (keys.size < inBox) {
    for (const key of keys) {
      const x = key % KEY_BASE;
      const y = Math.floor(key / KEY_BASE) % KEY_BASE;
      const z = Math.floor(key / (KEY_BASE * KEY_BASE));
      if (
        x >= lo[0] &&
        x <= hi[0] &&
        y >= lo[1] &&
        y <= hi[1] &&
        z >= lo[2] &&
        z <= hi[2]
      ) {
        return true;
      }
    }
    return false;
  }
  for (let z = lo[2]; z <= hi[2]; ++z) {
    for (let y = lo[1]; y <= hi[1]; ++y) {
      for (let x = lo[0]; x <= hi[0]; ++x) {
        if (keys.has(DraftRoutes.key(z, y, x))) return true;
      }
    }
  }
  return false;
}

export class DraftRoutes {
  /** By the `location` of the messages. */
  routes = new Map<string, DraftRoute>();
  /** How the page is told; the worker sets it before the first route exists. */
  notify: (notice: DraftNotice) => void = () => {};

  static key(z: number, y: number, x: number) {
    return (z * KEY_BASE + y) * KEY_BASE + x;
  }

  /** The route of the layer at `layerUrl`, if the page has sent one. */
  private find(layerUrl: string) {
    for (const route of this.routes.values()) {
      if (isLayerAt(layerUrl, route.location)) return route;
    }
    return undefined;
  }

  private touchedAt(route: DraftRoute, level: number): CellSet {
    return { cell: REGION_VOXELS / level, keys: route.touched };
  }

  apply(message: DraftMessage): DraftApplied {
    let route = this.routes.get(message.location);
    if (route === undefined) {
      route = {
        layerItemId: message.layerItemId,
        location: message.location,
        base: "",
        generation: -1,
        touched: new Set(),
        ahead: -1,
        aheadTimer: undefined,
        refused: new Set(),
        olderStateSeen: false,
      };
      this.routes.set(message.location, route);
    }
    const have = route.generation;
    const applied: DraftApplied = {
      ignored: false,
      gap: false,
      older: false,
      have,
      refresh: new Map(),
    };
    if (message.kind !== "state" && message.generation <= have) {
      applied.ignored = true;
      return applied;
    }
    const regionKeys = (regions: number[][]) =>
      regions.map(([z, y, x]) => DraftRoutes.key(z, y, x));
    if (message.kind === "state") {
      if (message.generation === have) {
        // The state the viewer has already (a poll's answer, say): reading
        // every touched chunk again would be the whole view once more.
        const regions = new Set(regionKeys(message.regions));
        if (
          regions.size === route.touched.size &&
          [...regions].every((key) => route.touched.has(key))
        ) {
          route.olderStateSeen = false;
          applied.ignored = true;
          return applied;
        }
      } else if (message.generation < have && !route.olderStateSeen) {
        // Read before a change the viewer has since been told about: applying
        // it would send the newest stroke's chunks back to the CDN. But a
        // backend that restarted counts from 0 again, so the page is asked
        // once more, and an older state that comes a second time is believed.
        route.olderStateSeen = true;
        applied.ignored = true;
        applied.older = true;
        return applied;
      }
      route.olderStateSeen = false;
    }
    route.layerItemId = message.layerItemId;
    if (message.kind !== "released") route.base = trimSlashes(message.base);

    if (message.kind === "state") {
      // The whole draft. Chunks of a region it no longer holds go back to the
      // CDN, so they are read again as well as the ones it holds now.
      const before = route.touched;
      route.touched = new Set(regionKeys(message.regions));
      const both = new Set([...before, ...route.touched]);
      if (both.size > 0) {
        for (const level of LEVELS) {
          applied.refresh.set(level, {
            cell: REGION_VOXELS / level,
            keys: both,
          });
        }
      }
      route.refused.clear();
      route.generation = message.generation;
    } else {
      applied.gap = message.prev !== have;
      if (message.kind === "changed") {
        const perRegion = REGION_VOXELS / KEY_VOXELS;
        for (const [level, keys] of Object.entries(message.changed)) {
          if (keys.length === 0) continue;
          applied.refresh.set(Number(level), {
            cell: KEY_VOXELS,
            keys: new Set(regionKeys(keys)),
          });
          if (level !== "1") continue;
          for (const [z, y, x] of keys) {
            route.touched.add(
              DraftRoutes.key(
                Math.floor(z / perRegion),
                Math.floor(y / perRegion),
                Math.floor(x / perRegion),
              ),
            );
          }
        }
      } else {
        // The layer now holds what the screen shows for these regions: their
        // next read goes to the CDN and gets the same voxels, so nothing is
        // read now.
        for (const key of regionKeys(message.regions)) {
          route.touched.delete(key);
        }
      }
      route.generation = message.generation;
    }
    if (route.generation >= route.ahead) this.caughtUp(route);
    return applied;
  }

  /**
   * Where to read the chunk at `pos` (x, y, z) of `size` from the draft
   * route, or nothing when the CDN serves it. The box asked for is the
   * chunk's own, in the form the CDN's path has.
   */
  request(
    sourceUrl: string | undefined,
    pos: ArrayLike<number>,
    size: ArrayLike<number>,
  ) {
    if (this.routes.size === 0) return undefined;
    const scale = parseScaleUrl(sourceUrl);
    if (scale === undefined) return undefined;
    const route = this.find(scale.layer);
    if (route === undefined) return undefined;
    if (!meets(this.touchedAt(route, scale.level), pos, size)) return undefined;
    const box =
      `${pos[0]}-${pos[0] + size[0]}_` +
      `${pos[1]}-${pos[1] + size[1]}_` +
      `${pos[2]}-${pos[2] + size[2]}`;
    // The generation only makes the URL new for every generation: the route
    // always answers the newest draft, and a browser queues a second GET of
    // one URL behind the first.
    return {
      route,
      url: `${route.base}/${scale.level}/${box}?gen=${route.generation}`,
    };
  }

  /**
   * The chunk's bytes from the draft route, or nothing when the chunk is to
   * be read from the CDN: the draft does not cover it, or the route refused
   * (the saved layer is shown there, and the page is told once). `pos` is
   * read before this returns, so the caller may pass a scratch array.
   */
  read(
    sourceUrl: string | undefined,
    pos: ArrayLike<number>,
    size: ArrayLike<number>,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | undefined> | undefined {
    const request = this.request(sourceUrl, pos, size);
    if (request === undefined) return undefined;
    return this.fetchChunk(request.route, request.url, signal);
  }

  private async fetchChunk(
    route: DraftRoute,
    url: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | undefined> {
    // The viewer and the API are one origin on a site and two ports of
    // localhost in development; "include" sends the sign-in cookie to both.
    // Read as the CDN is read: `fetchOk` tries again after 429, 503, 504 and
    // after a network error. A read that fails for good leaves the chunk
    // failed, and nothing reads a failed chunk again.
    let response: Response;
    try {
      response = await fetchOk(url, { signal, credentials: "include" });
    } catch (error) {
      if (!(error instanceof HttpError) || !REFUSALS.has(error.status)) {
        throw error;
      }
      this.refused(route, error.status);
      return undefined;
    }
    const generation = Number(response.headers.get("X-Draft-Generation"));
    if (generation > route.generation) this.sawAhead(route, generation);
    return await response.arrayBuffer();
  }

  /** The route refused a chunk: the page is told once for each status. */
  private refused(route: DraftRoute, status: number) {
    // No state request here: the same read would be refused again.
    if (!route.refused.has(status)) {
      route.refused.add(status);
      this.notify({
        kind: "refused",
        layerItemId: route.layerItemId,
        location: route.location,
        status,
      });
    }
  }

  /** An answer is newer than the last message: give that message a second. */
  private sawAhead(route: DraftRoute, generation: number) {
    if (generation <= route.ahead) return;
    route.ahead = generation;
    clearTimeout(route.aheadTimer);
    route.aheadTimer = setTimeout(() => {
      route.aheadTimer = undefined;
      if (route.generation >= route.ahead) return;
      this.notify({
        kind: "behind",
        layerItemId: route.layerItemId,
        location: route.location,
        have: route.generation,
      });
    }, BEHIND_WAIT_MS);
  }

  private caughtUp(route: DraftRoute) {
    clearTimeout(route.aheadTimer);
    route.aheadTimer = undefined;
    route.ahead = -1;
  }

  /** Whether the chunk would be computed by the draft route at a level it is not read ahead at. */
  skipsPrefetch(
    sourceUrl: string | undefined,
    pos: ArrayLike<number>,
    size: ArrayLike<number>,
  ) {
    if (this.routes.size === 0) return false;
    const scale = parseScaleUrl(sourceUrl);
    if (scale === undefined || scale.level <= PREFETCH_MAX_LEVEL) return false;
    const route = this.find(scale.layer);
    return (
      route !== undefined &&
      meets(this.touchedAt(route, scale.level), pos, size)
    );
  }
}

/** The routes of this worker. */
export const draftRoutes = new DraftRoutes();

/** The part of a volume chunk source that the prefetch rule looks at. */
export interface PrefetchSourceLike {
  parameters?: { url?: string };
  spec: {
    chunkDataSize: ArrayLike<number>;
    baseVoxelOffset?: ArrayLike<number>;
  };
}

const tempPosition = [0, 0, 0];

/** `DraftRoutes.skipsPrefetch` for the chunk of `source` at a grid position. */
export function draftSkipsPrefetch(
  source: PrefetchSourceLike,
  chunkGridPosition: ArrayLike<number>,
) {
  if (draftRoutes.routes.size === 0) return false;
  const { chunkDataSize, baseVoxelOffset } = source.spec;
  for (let i = 0; i < 3; ++i) {
    tempPosition[i] =
      chunkGridPosition[i] * chunkDataSize[i] + (baseVoxelOffset?.[i] ?? 0);
  }
  return draftRoutes.skipsPrefetch(
    source.parameters?.url,
    tempPosition,
    chunkDataSize,
  );
}

export interface DraftUpdateResult {
  ignored: boolean;
  gap: boolean;
  older: boolean;
  have: number;
  /** Chunks on screen that were read again and replaced in place. */
  refreshed: number;
  skipped: number;
  failed: number;
  /** Chunks that were not on screen and were dropped. */
  dropped: number;
}

/** The part of a volume chunk source that finding its changed chunks uses. */
interface DraftSourceLike {
  parameters?: { url?: string };
  chunks: Map<string, { key?: string | null; chunkDataSize?: unknown }>;
  /** The chunk's position (x, y, z); sets the chunk's `chunkDataSize`. */
  computeChunkBounds?(chunk: unknown): ArrayLike<number>;
  chunkManager?: { scheduleUpdateChunkPriorities(): void };
}

interface DraftQueueLike {
  sources: Iterable<unknown>;
  invalidateCachedChunks(
    source: any,
    keys: Iterable<string>,
    signal: AbortSignal,
  ): Promise<{
    refreshed: number;
    skipped: number;
    failed: number;
    dropped: number;
  }>;
}

/**
 * Applies a page message to the layer's route and reads again what it says
 * changed: every cached chunk of every source of that layer whose box meets a
 * changed cell of the source's level. A layer has several sources per level
 * (slabs one voxel thick along each axis for the slice views, cubes for 3D),
 * and a changed key is a 32^3 cube, so the match is by box, never by chunk
 * key.
 */
export async function applyDraftMessage(
  queue: DraftQueueLike,
  message: DraftMessage,
  signal: AbortSignal,
  routes = draftRoutes,
): Promise<DraftUpdateResult> {
  const applied = routes.apply(message);
  const result: DraftUpdateResult = {
    ignored: applied.ignored,
    gap: applied.gap,
    older: applied.older,
    have: applied.have,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    dropped: 0,
  };
  if (applied.refresh.size === 0) return result;
  const reads = [];
  for (const source of queue.sources as Iterable<DraftSourceLike>) {
    if (source.computeChunkBounds === undefined) continue;
    const scale = parseScaleUrl(source.parameters?.url);
    if (scale === undefined || !isLayerAt(scale.layer, message.location)) {
      continue;
    }
    const cells = applied.refresh.get(scale.level);
    if (cells === undefined) continue;
    // Which chunks are read ahead depends on what the draft covers, and that
    // has just changed: have the views work out again what they want, so a
    // chunk dropped below is not fetched again for a tier it no longer has.
    source.chunkManager?.scheduleUpdateChunkPriorities();
    const keys: string[] = [];
    for (const chunk of source.chunks.values()) {
      const position = source.computeChunkBounds(chunk);
      if (meets(cells, position, chunk.chunkDataSize as ArrayLike<number>)) {
        keys.push(chunk.key!);
      }
    }
    if (keys.length > 0) {
      reads.push(queue.invalidateCachedChunks(source, keys, signal));
    }
  }
  for (const outcome of await Promise.all(reads)) {
    result.refreshed += outcome.refreshed;
    result.skipped += outcome.skipped;
    result.failed += outcome.failed;
    result.dropped += outcome.dropped;
  }
  return result;
}

function isKeyList(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (key) =>
        Array.isArray(key) &&
        key.length === 3 &&
        key.every((v) => Number.isInteger(v)),
    )
  );
}

/** The fields of a draft message from the page, or nothing when `data` is not one. */
export function draftMessage(data: unknown): DraftMessage | undefined {
  const m = data as Record<string, unknown> | null | undefined;
  if (
    typeof m?.layerItemId !== "string" ||
    typeof m.location !== "string" ||
    !Number.isInteger(m.generation)
  ) {
    return undefined;
  }
  const layer = { layerItemId: m.layerItemId, location: m.location };
  const generation = m.generation as number;
  switch (m.type) {
    case "draft_state":
      if (typeof m.base !== "string" || !isKeyList(m.regions)) return undefined;
      return {
        kind: "state",
        ...layer,
        base: m.base,
        generation,
        regions: m.regions,
      };
    case "draft_changed": {
      const changed = m.changed as Record<string, unknown> | null | undefined;
      if (
        typeof m.base !== "string" ||
        !Number.isInteger(m.prev) ||
        typeof changed !== "object" ||
        changed === null ||
        !Object.values(changed).every(isKeyList)
      ) {
        return undefined;
      }
      return {
        kind: "changed",
        ...layer,
        base: m.base,
        generation,
        prev: m.prev as number,
        changed: changed as Record<string, number[][]>,
      };
    }
    case "draft_released":
      if (!Number.isInteger(m.prev) || !isKeyList(m.regions)) return undefined;
      return {
        kind: "released",
        ...layer,
        generation,
        prev: m.prev as number,
        regions: m.regions,
      };
  }
  return undefined;
}

/** What the page is sent for a notice of the worker. */
export function noticeForPage(notice: DraftNotice) {
  const { layerItemId, location } = notice;
  if (notice.kind === "refused") {
    return {
      type: "draft_chunk_refused",
      layerItemId,
      location,
      status: notice.status,
    };
  }
  return {
    type: "draft_state_request",
    layerItemId,
    location,
    have: notice.have,
    reason: "behind",
  };
}

/** What the page-side handling of a draft message needs from the viewer. */
export interface DraftPageEnv {
  /** The window that embeds the viewer: the only sender that is listened to. */
  parent: unknown;
  /** Hands the message to the chunk worker. */
  invoke(message: DraftMessage): Promise<DraftUpdateResult>;
  /** Posts to the embedding page. */
  post(message: object): void;
  redraw(): void;
}

/**
 * The viewer's `message` listener calls this first. True when the event was a
 * draft message, whether or not it was acted on.
 *
 * Only the embedding page is listened to: a draft message names a URL that
 * the worker then reads with the user's cookie.
 *
 * The worker's answer says when the page has to send the whole draft again:
 * a message before this one never arrived (`gap`), or the state it sent is
 * older than what the viewer has (`older`).
 */
export function handleDraftWindowMessage(
  event: { data: unknown; source: unknown },
  env: DraftPageEnv,
): boolean {
  const message = draftMessage(event.data);
  if (message === undefined) return false;
  if (event.source !== env.parent) return true;
  env
    .invoke(message)
    .then((result) => {
      const reason = result.gap ? "gap" : result.older ? "older" : undefined;
      if (reason !== undefined) {
        env.post({
          type: "draft_state_request",
          layerItemId: message.layerItemId,
          location: message.location,
          have: result.have,
          reason,
        });
      }
      env.redraw();
    })
    .catch((err: unknown) => {
      console.error("could not apply a draft message:", err);
    });
  return true;
}
