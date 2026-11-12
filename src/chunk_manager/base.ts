/**
 * @license
 * Copyright 2016 Google Inc.
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

export enum ChunkState {
  // Chunk is stored in GPU memory in addition to system memory.
  GPU_MEMORY = 0,
  // Chunk is stored only in system memory but not in GPU memory.
  SYSTEM_MEMORY = 1,

  // Chunk is stored in system memory on worker.
  SYSTEM_MEMORY_WORKER = 2,

  // Chunk is downloading.
  DOWNLOADING = 3,
  // Chunk is not yet downloading.
  QUEUED = 4,

  // Chunk has just been added.
  NEW = 5,

  // Download failed.
  FAILED = 6,

  EXPIRED = 7,

  // If new states are added, keep numChangeStates in sync.
}

export const numChunkStates = 8;

export enum ChunkPriorityTier {
  // oxlint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  FIRST_TIER = 0,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  FIRST_ORDERED_TIER = 0,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  VISIBLE = 0,
  // oxlint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  PREFETCH = 1,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  LAST_ORDERED_TIER = 1,
  // oxlint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  RECENT = 2,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  LAST_TIER = 2,
}

export const numChunkPriorityTiers = 3;

export enum ChunkDownloadStatistics {
  totalTime = 0,
  totalChunks = 1,
}

export enum ChunkMemoryStatistics {
  numChunks = 0,
  systemMemoryBytes = 1,
  gpuMemoryBytes = 2,
}

export const numChunkMemoryStatistics = 3;

export const numChunkDownloadStatistics = 2;

export const numChunkStatistics =
  numChunkStates * numChunkPriorityTiers * numChunkMemoryStatistics +
  numChunkDownloadStatistics;

export function getChunkStateStatisticIndex(
  state: ChunkState,
  priorityTier: ChunkPriorityTier,
) {
  return state * numChunkPriorityTiers + priorityTier;
}

export function getChunkDownloadStatisticIndex(
  statistic: ChunkDownloadStatistics,
) {
  return (
    numChunkStates * numChunkPriorityTiers * numChunkMemoryStatistics +
    statistic
  );
}

export const PREFETCH_PRIORITY_MULTIPLIER = 1e13;

export const CHUNK_QUEUE_MANAGER_RPC_ID = "ChunkQueueManager";
export const CHUNK_MANAGER_RPC_ID = "ChunkManager";
export const CHUNK_SOURCE_INVALIDATE_RPC_ID = "ChunkSource.invalidate";
export const CHUNK_SOURCE_REFRESH_RPC_ID = "ChunkSource.refresh";

/** What a soft refresh of one chunk source did (see `ChunkSource.refreshCache`). */
export interface ChunkSourceRefreshResult {
  /** Chunks on screen that were read again and replaced in place. */
  refreshed: number;
  /** Chunks left alone because they were no longer in the cache, or the refresh was cancelled. */
  skipped: number;
  /** Chunks whose read failed; each was dropped, so the normal queue reads it from scratch. */
  failed: number;
  /** The source cannot be refreshed in place, so it was invalidated the old way. */
  fellBack: boolean;
  /** A newer refresh of the same source started, and took over the chunks this one had not replaced. */
  superseded: boolean;
}

/** What `ChunkQueueManager.invalidateCachedChunks` did with the chunks it was given. */
export interface ChunksInvalidateResult {
  /** Chunks on screen that were read again and replaced in place. */
  refreshed: number;
  /** Chunks a newer call took over, or that left the GPU before their new data came. */
  skipped: number;
  /** Chunks whose read failed; each was dropped. */
  failed: number;
  /** Chunks that were not on screen and were dropped, to be read from scratch when needed. */
  dropped: number;
}

export const REQUEST_CHUNK_STATISTICS_RPC_ID =
  "ChunkQueueManager.requestChunkStatistics";

// Used for sending per-layer visible/prefetch chunk statistics from backend to frontend.
export const CHUNK_LAYER_STATISTICS_RPC_ID =
  "ChunkManager.chunkLayerStatistics";

export interface ChunkSourceParametersConstructor<T> {
  new (): T;
  RPC_ID: string;
}

export class LayerChunkProgressInfo {
  numVisibleChunksNeeded = 0;
  numVisibleChunksAvailable = 0;
  numPrefetchChunksNeeded = 0;
  numPrefetchChunksAvailable = 0;
}
