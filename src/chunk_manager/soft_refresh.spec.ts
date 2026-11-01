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
 * A soft refresh reads the chunks of a source again WITHOUT taking away what
 * the source shows: the chunk on screen stays until the new data for the same
 * key has arrived, and is then replaced in one step. The invalidation that
 * exists already (`invalidateSourceCache`) empties the whole source first and
 * is left as it is; these tests are about the other path only.
 */

import { describe, expect, it, vi } from "vitest";

import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import {
  Slots,
  type RefreshOps,
  UpdateHold,
  pause,
  planRefresh,
  putChunk,
  runRefresh,
  type ShownChunk,
} from "#src/chunk_manager/soft_refresh.js";

function chunk(
  key: string,
  state: ChunkState,
  priorityTier: ChunkPriorityTier,
  priority = 0,
): ShownChunk {
  return { key, state, priorityTier, priority };
}

describe("planRefresh", () => {
  it("refreshes the chunks that are shown, nearest first, and evicts the rest", () => {
    const shownFar = chunk(
      "far",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.VISIBLE,
      -5,
    );
    const shownNear = chunk(
      "near",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.VISIBLE,
      -1,
    );
    const prefetched = chunk(
      "prefetched",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.PREFETCH,
      -2,
    );
    const cachedOnly = chunk(
      "cached",
      ChunkState.GPU_MEMORY,
      ChunkPriorityTier.RECENT,
    );
    const inMemory = chunk(
      "memory",
      ChunkState.SYSTEM_MEMORY,
      ChunkPriorityTier.VISIBLE,
    );
    const inWorker = chunk(
      "worker",
      ChunkState.SYSTEM_MEMORY_WORKER,
      ChunkPriorityTier.VISIBLE,
    );
    const downloading = chunk(
      "loading",
      ChunkState.DOWNLOADING,
      ChunkPriorityTier.VISIBLE,
    );
    const queued = chunk(
      "queued",
      ChunkState.QUEUED,
      ChunkPriorityTier.VISIBLE,
    );
    const failed = chunk(
      "failed",
      ChunkState.FAILED,
      ChunkPriorityTier.VISIBLE,
    );

    const plan = planRefresh([
      shownFar,
      cachedOnly,
      prefetched,
      inMemory,
      shownNear,
      inWorker,
      downloading,
      queued,
      failed,
    ]);

    expect(plan.refresh.map((c) => c.key)).toEqual([
      "near",
      "far",
      "prefetched",
    ]);
    expect(plan.evict.map((c) => c.key).sort()).toEqual(
      ["cached", "failed", "loading", "memory", "queued", "worker"].sort(),
    );
  });

  it("does not change what it was given", () => {
    const chunks = [
      chunk("a", ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE, 1),
      chunk("b", ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE, 2),
    ];
    const before = chunks.map((c) => c.key);

    planRefresh(chunks);

    expect(chunks.map((c) => c.key)).toEqual(before);
  });

  it("plans nothing for a source with no chunks", () => {
    expect(planRefresh([])).toEqual({ refresh: [], evict: [] });
  });
});

type Fresh = { empty: boolean; tag: string };

/** Fake collaborators: records what happened, in order. */
function fakeOps(
  options: {
    reads?: (key: string, attempt: number) => Fresh | Error | "never";
    hadData?: (key: string) => boolean;
    current?: (key: string) => boolean;
  } = {},
) {
  const log: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const ops: RefreshOps<ShownChunk, Fresh> = {
    async readFresh(c, signal) {
      const attempt = (attempts.get(c.key!) ?? 0) + 1;
      attempts.set(c.key!, attempt);
      log.push(`read ${c.key} #${attempt}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1));
        const answer = options.reads?.(c.key!, attempt) ?? {
          empty: false,
          tag: `${c.key}-new`,
        };
        if (answer === "never") {
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        }
        if (answer instanceof Error) throw answer;
        return answer as Fresh;
      } finally {
        inFlight--;
      }
    },
    isEmpty: (fresh) => fresh.empty,
    hadData: (c) => options.hadData?.(c.key!) ?? true,
    isCurrent: (c) => options.current?.(c.key!) ?? true,
    swap(c, fresh) {
      log.push(`swap ${c.key} <- ${fresh.tag}`);
    },
    fallBack(c) {
      log.push(`fallback ${c.key}`);
    },
    wait(ms) {
      log.push(`wait ${ms}`);
      return Promise.resolve();
    },
  };
  return { ops, log, maxInFlight: () => maxInFlight, attempts };
}

const shown = (key: string) =>
  chunk(key, ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE);
const options = (extra: Partial<{ concurrency: number }> = {}) => ({
  signal: new AbortController().signal,
  concurrency: 4,
  rereadDelayMs: 300,
  ...extra,
});

describe("runRefresh", () => {
  it("replaces every shown chunk with its new data, once, and falls back for none", async () => {
    const { ops, log } = fakeOps();

    const outcome = await runRefresh(
      [shown("a"), shown("b"), shown("c")],
      ops,
      options(),
    );

    expect(outcome).toEqual({ refreshed: 3, skipped: 0, failed: 0 });
    expect(log.filter((l) => l.startsWith("swap")).sort()).toEqual([
      "swap a <- a-new",
      "swap b <- b-new",
      "swap c <- c-new",
    ]);
    expect(log.some((l) => l.startsWith("fallback"))).toBe(false);
    expect(log.filter((l) => l.startsWith("read"))).toHaveLength(3);
  });

  it("swaps only after the new data has arrived", async () => {
    const { ops, log } = fakeOps();

    await runRefresh([shown("a")], ops, options());

    expect(log.indexOf("read a #1")).toBeLessThan(
      log.indexOf("swap a <- a-new"),
    );
  });

  it("reads a chunk that had data again when the first read is empty, and swaps the second", async () => {
    const { ops, log } = fakeOps({
      reads: (_key, attempt) =>
        attempt === 1
          ? { empty: true, tag: "empty" }
          : { empty: false, tag: "second" },
    });

    const outcome = await runRefresh([shown("a")], ops, options());

    expect(log).toEqual([
      "read a #1",
      "wait 300",
      "read a #2",
      "swap a <- second",
    ]);
    expect(outcome.refreshed).toBe(1);
  });

  it("accepts an empty chunk after two empty reads", async () => {
    const { ops, log } = fakeOps({
      reads: () => ({ empty: true, tag: "empty" }),
    });

    const outcome = await runRefresh([shown("a")], ops, options());

    expect(log).toEqual([
      "read a #1",
      "wait 300",
      "read a #2",
      "swap a <- empty",
    ]);
    expect(outcome).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
  });

  it("does not read a chunk that never had data a second time", async () => {
    // A chunk nobody ever wrote is a 404 and comes back empty each time;
    // most of what a view shows is like that, and a second read of each would
    // double the reads a whole room of users makes.
    const { ops, log } = fakeOps({
      reads: () => ({ empty: true, tag: "empty" }),
      hadData: () => false,
    });

    const outcome = await runRefresh([shown("a")], ops, options());

    expect(log).toEqual(["read a #1", "swap a <- empty"]);
    expect(outcome.refreshed).toBe(1);
  });

  it("does not swap in data for a chunk that is no longer the one on screen", async () => {
    let gone = false;
    const { ops, log } = fakeOps({ current: () => !gone });
    const original = ops.readFresh;
    ops.readFresh = async (c, signal) => {
      const fresh = await original(c, signal);
      gone = true; // evicted or invalidated while the read was out
      return fresh;
    };

    const outcome = await runRefresh([shown("a")], ops, options());

    expect(log.some((l) => l.startsWith("swap"))).toBe(false);
    expect(outcome).toEqual({ refreshed: 0, skipped: 1, failed: 0 });
  });

  it("does not even read a chunk that went away before its turn", async () => {
    const { ops, log } = fakeOps({ current: (key) => key !== "b" });

    const outcome = await runRefresh(
      [shown("a"), shown("b")],
      ops,
      options({ concurrency: 1 }),
    );

    expect(log.filter((l) => l.startsWith("read"))).toEqual(["read a #1"]);
    expect(outcome).toEqual({ refreshed: 1, skipped: 1, failed: 0 });
  });

  it("falls back to a full invalidation of only the chunk whose read failed", async () => {
    const { ops, log } = fakeOps({
      reads: (key) =>
        key === "b"
          ? new Error("network")
          : { empty: false, tag: `${key}-new` },
    });

    const outcome = await runRefresh(
      [shown("a"), shown("b"), shown("c")],
      ops,
      options(),
    );

    expect(outcome).toEqual({ refreshed: 2, skipped: 0, failed: 1 });
    expect(log.filter((l) => l.startsWith("fallback"))).toEqual(["fallback b"]);
    expect(log.filter((l) => l.startsWith("swap")).sort()).toEqual([
      "swap a <- a-new",
      "swap c <- c-new",
    ]);
  });

  it("leaves a chunk that is gone alone when its read failed", async () => {
    const { ops, log } = fakeOps({
      reads: () => new Error("network"),
      current: () => false,
    });

    const outcome = await runRefresh([shown("a")], ops, options());

    expect(log.some((l) => l.startsWith("fallback"))).toBe(false);
    expect(outcome.skipped + outcome.failed).toBe(1);
  });

  it("never has more reads out than allowed, and reads them all", async () => {
    const fake = fakeOps();
    const many = Array.from({ length: 10 }, (_, i) => shown(`c${i}`));

    const outcome = await runRefresh(
      many,
      fake.ops,
      options({ concurrency: 3 }),
    );

    expect(outcome.refreshed).toBe(10);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(3);
    expect(fake.maxInFlight()).toBeGreaterThan(1);
  });

  it("reads in the order it is given when it reads one at a time", async () => {
    const { ops, log } = fakeOps();

    await runRefresh(
      [shown("first"), shown("second"), shown("third")],
      ops,
      options({ concurrency: 1 }),
    );

    expect(log.filter((l) => l.startsWith("read"))).toEqual([
      "read first #1",
      "read second #1",
      "read third #1",
    ]);
  });

  it("stops when it is cancelled: nothing is swapped afterwards and a cancelled read is not a failure", async () => {
    const controller = new AbortController();
    const { ops, log } = fakeOps({ reads: () => "never" });

    const running = runRefresh([shown("a"), shown("b")], ops, {
      signal: controller.signal,
      concurrency: 1,
      rereadDelayMs: 300,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new DOMException("cancelled", "AbortError"));
    const outcome = await running;

    expect(log.some((l) => l.startsWith("swap"))).toBe(false);
    expect(log.some((l) => l.startsWith("fallback"))).toBe(false);
    expect(outcome.failed).toBe(0);
    expect(outcome.refreshed).toBe(0);
    expect(outcome.skipped).toBe(2);
  });

  it("does nothing for no chunks", async () => {
    const { ops, log } = fakeOps();

    expect(await runRefresh([], ops, options())).toEqual({
      refreshed: 0,
      skipped: 0,
      failed: 0,
    });
    expect(log).toEqual([]);
  });
});

describe("putChunk", () => {
  function cache() {
    const chunks = new Map<string, { id: string }>();
    return {
      chunks,
      deleteChunk: vi.fn((key: string) => {
        chunks.delete(key);
      }),
      addChunk: vi.fn((key: string, c: { id: string }) => {
        chunks.set(key, c);
      }),
    };
  }

  it("just adds a chunk that has no predecessor", () => {
    const c = cache();

    putChunk(c, "k", { id: "new" });

    expect(c.deleteChunk).not.toHaveBeenCalled();
    expect(c.chunks.get("k")).toEqual({ id: "new" });
  });

  it("takes out the chunk it replaces first, so the old one's GPU memory is freed", () => {
    const c = cache();
    c.chunks.set("k", { id: "old" });
    const order: string[] = [];
    c.deleteChunk.mockImplementation((key: string) => {
      order.push("delete");
      c.chunks.delete(key);
    });
    c.addChunk.mockImplementation((key: string, ch: { id: string }) => {
      order.push("add");
      c.chunks.set(key, ch);
    });

    putChunk(c, "k", { id: "new" });

    expect(order).toEqual(["delete", "add"]);
    expect(c.chunks.get("k")).toEqual({ id: "new" });
    expect(c.chunks.size).toBe(1);
  });
});

describe("Slots", () => {
  const never = new AbortController().signal;

  it("hands out as many slots as it has, and makes the next caller wait", async () => {
    const slots = new Slots(2);
    const order: string[] = [];

    const releaseA = await slots.acquire(never);
    const releaseB = await slots.acquire(never);
    const third = slots.acquire(never).then((release) => {
      order.push("third");
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseA();
    const releaseC = await third;

    expect(order).toEqual(["third"]);
    releaseB();
    releaseC();
  });

  it("serves the callers in the order they asked", async () => {
    const slots = new Slots(1);
    const order: string[] = [];
    const first = await slots.acquire(never);
    const waiting = ["a", "b", "c"].map((name) =>
      slots.acquire(never).then((release) => {
        order.push(name);
        release();
      }),
    );

    first();
    await Promise.all(waiting);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("gives a slot back only once, however often the release is called", async () => {
    const slots = new Slots(1);
    const release = await slots.acquire(never);
    release();
    release();

    const a = await slots.acquire(never);
    let second = false;
    const waiting = slots.acquire(never).then(() => {
      second = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(second, "the double release made a slot out of nothing").toBe(false);
    a();
    await waiting;
  });

  it("lets a caller that gives up leave the line without taking a slot", async () => {
    const slots = new Slots(1);
    const holder = await slots.acquire(never);
    const controller = new AbortController();
    const leaving = slots.acquire(controller.signal);
    const staying = slots.acquire(never);

    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(leaving).rejects.toMatchObject({ name: "AbortError" });
    holder();
    const release = await staying;

    release();
    // nothing is lost: both slots calls were settled and the slot is free again
    const again = await slots.acquire(never);
    again();
  });

  it("refuses a caller whose signal has already aborted, and keeps the slot free", async () => {
    const slots = new Slots(1);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(slots.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const release = await slots.acquire(never);
    release();
  });
});

describe("pause", () => {
  it("resolves when the time is up, and not before", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = pause(300, new AbortController().signal).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the reason when it is cancelled, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = pause(300, controller.signal);
      const settled = expect(waiting).rejects.toMatchObject({
        name: "AbortError",
      });

      controller.abort(new DOMException("cancelled", "AbortError"));
      await settled;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects at once for a signal that has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pause(300, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("UpdateHold", () => {
  type Update = { id: string; refresh?: boolean };
  const swap = (id: string): Update => ({ id, refresh: true });
  const plain = (id: string): Update => ({ id });
  const sourceA = { name: "a" };
  const sourceB = { name: "b" };

  it("keeps nothing while no hold is active", () => {
    const hold = new UpdateHold<object, Update>();

    expect(hold.keep(sourceA, swap("s1"))).toBe(false);
    expect(hold.keep(sourceA, plain("p1"))).toBe(false);
  });

  it("keeps the replacements of a refresh, and gives them back in order when the hold ends", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();

    expect(hold.keep(sourceA, swap("s1"))).toBe(true);
    expect(hold.keep(sourceB, swap("s2"))).toBe(true);
    expect(hold.keep(sourceA, swap("s3"))).toBe(true);

    expect(hold.end().map((u) => u.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("lets updates of other sources through: only what the refresh replaces is held", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();
    hold.keep(sourceA, swap("s1"));

    expect(hold.keep(sourceB, plain("other layer panning in"))).toBe(false);
  });

  it("keeps a later update of a source that has a held replacement, so its updates stay in the order they were sent", () => {
    // A replacement, then the worker evicting the same chunk: applying the eviction first and the
    // replacement later would leave a chunk on the GPU that the worker has already dropped.
    const hold = new UpdateHold<object, Update>();
    hold.begin();
    hold.keep(sourceA, swap("replace"));

    expect(hold.keep(sourceA, plain("evict"))).toBe(true);

    expect(hold.end().map((u) => u.id)).toEqual(["replace", "evict"]);
  });

  it("holds only from the first replacement of a source: an earlier update of it is not kept", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();

    expect(hold.keep(sourceA, plain("before"))).toBe(false);
    hold.keep(sourceA, swap("s1"));
    expect(hold.keep(sourceA, plain("after"))).toBe(true);
  });

  it("keeps nothing after the hold has ended: a replacement that arrives late is applied as it comes", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();
    hold.keep(sourceA, swap("s1"));
    hold.end();

    expect(hold.keep(sourceA, swap("late"))).toBe(false);
    expect(hold.keep(sourceA, plain("p"))).toBe(false);
  });

  it("gives the updates back only when the last of several holds ends", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();
    hold.begin();
    hold.keep(sourceA, swap("s1"));

    expect(hold.end()).toEqual([]);
    expect(hold.keep(sourceA, swap("s2"))).toBe(true);
    expect(hold.end().map((u) => u.id)).toEqual(["s1", "s2"]);
  });

  it("ignores an end that has no begin, and does not make the next hold end early", () => {
    const hold = new UpdateHold<object, Update>();

    expect(hold.end()).toEqual([]);
    hold.begin();
    hold.keep(sourceA, swap("s1"));

    expect(hold.end().map((u) => u.id)).toEqual(["s1"]);
  });

  it("starts the next hold empty", () => {
    const hold = new UpdateHold<object, Update>();
    hold.begin();
    hold.keep(sourceA, swap("s1"));
    hold.end();
    hold.begin();

    expect(hold.keep(sourceA, plain("p"))).toBe(false);
    expect(hold.end()).toEqual([]);
  });
});
