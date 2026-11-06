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

// A chunk read whose connection is reset used to come back as "this chunk does
// not exist" (an empty chunk that nothing reads again). These tests use a real
// HTTP server that resets the connection (a TCP RST, the same failure as
// `net::ERR_CONNECTION_RESET` in the browser) for the first N requests of a
// path and then answers normally.

import "#src/kvstore/http/register_frontend.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  fetchOk,
  HttpError,
  pickNetworkErrorDelay,
} from "#src/util/http_request.js";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";

const CHUNK_BYTES = "chunk-bytes";

describe("network errors on a chunk read", () => {
  const sharedKvStoreContext = sharedKvStoreContextFixture();

  // Requests seen per path, and how many of the first requests to reset.
  let requestCounts: Map<string, number>;
  let resetFirst: Map<string, number>;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      const count = (requestCounts.get(path) ?? 0) + 1;
      requestCounts.set(path, count);
      if (count <= (resetFirst.get(path) ?? 0)) {
        req.socket.resetAndDestroy();
        return;
      }
      if (path.startsWith("/missing")) {
        res.writeHead(404).end();
      } else if (path.startsWith("/forbidden")) {
        res.writeHead(403).end();
      } else {
        res
          .writeHead(200, { "content-length": CHUNK_BYTES.length })
          .end(CHUNK_BYTES);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "localhost", () => resolve());
    });
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    requestCounts = new Map();
    resetFirst = new Map();
  });

  async function read(path: string, options: { signal?: AbortSignal } = {}) {
    const context = (await sharedKvStoreContext()).kvStoreContext;
    return context.read(`${baseUrl}${path}`, options);
  }

  test("one reset: the chunk is returned", async () => {
    resetFirst.set("/chunk-1", 1);
    const response = await read("/chunk-1");
    expect(response).not.toBe(undefined);
    expect(await response!.response.text()).toEqual(CHUNK_BYTES);
    expect(requestCounts.get("/chunk-1")).toBe(2);
  });

  test("two resets in a row: the chunk is returned", async () => {
    resetFirst.set("/chunk-2", 2);
    const response = await read("/chunk-2");
    expect(response).not.toBe(undefined);
    expect(await response!.response.text()).toEqual(CHUNK_BYTES);
    expect(requestCounts.get("/chunk-2")).toBe(3);
  });

  test("a real 404 stays missing and is asked for once", async () => {
    expect(await read("/missing-1")).toBe(undefined);
    expect(requestCounts.get("/missing-1")).toBe(1);
  });

  test("a 403 stays missing and is asked for once", async () => {
    expect(await read("/forbidden-1")).toBe(undefined);
    expect(requestCounts.get("/forbidden-1")).toBe(1);
  });

  test("a server that never answers is asked a bounded number of times", async () => {
    resetFirst.set("/down", Infinity);
    const start = performance.now();
    // After the last attempt the read is reported the way it always was.
    expect(await read("/down")).toBe(undefined);
    const elapsed = performance.now() - start;
    expect(requestCounts.get("/down")).toBe(3);
    // Waits between attempts: at least 250 ms, then at least 500 ms.
    expect(elapsed).toBeGreaterThanOrEqual(750);
    // Waits are below 500 ms, then below 1000 ms.
    expect(elapsed).toBeLessThan(3000);
  });

  test("an aborted read does not start another attempt", async () => {
    resetFirst.set("/aborted", Infinity);
    const controller = new AbortController();
    const result = read("/aborted", { signal: controller.signal });
    // Let the first attempt fail, then abort while it waits to try again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(requestCounts.get("/aborted")).toBe(1);
  });

  test("a request that is not a GET or HEAD is not repeated", async () => {
    resetFirst.set("/post", Infinity);
    const error = await fetchOk(`${baseUrl}/post`, { method: "POST" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(0);
    expect(requestCounts.get("/post")).toBe(1);
  });
});

test("the wait before a repeat is 250 to 500 ms, then 500 to 1000 ms", () => {
  for (let i = 0; i < 100; ++i) {
    const first = pickNetworkErrorDelay(0);
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThanOrEqual(500);
    const second = pickNetworkErrorDelay(1);
    expect(second).toBeGreaterThanOrEqual(500);
    expect(second).toBeLessThanOrEqual(1000);
  }
});
