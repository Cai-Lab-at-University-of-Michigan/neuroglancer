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
 * The two layouts with the three cross sections and no 3D view. A layout name
 * the viewer does not know throws while the state is restored, so these names
 * must be registered before the portal can store them.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type * as LayoutModule from "#src/data_panel_layout.js";

let layouts: typeof LayoutModule;

beforeAll(async () => {
  // The module reads WebGL constants while loading, which node does not
  // have. Nothing here draws, so any number will do.
  (globalThis as any).WebGL2RenderingContext ??= new Proxy(
    {},
    { get: (_target, key) => (typeof key === "string" ? 0 : undefined) },
  );
  layouts = await import("#src/data_panel_layout.js");
});

describe("three-panel layouts", () => {
  it("are registered under the names the portal stores", () => {
    expect(layouts.validateLayoutName("3panel")).toBe("3panel");
    expect(layouts.validateLayoutName("3panel-xy")).toBe("3panel-xy");
    expect(layouts.THREE_PANEL_LAYOUTS.get("3panel")).toBe("row");
    expect(layouts.THREE_PANEL_LAYOUTS.get("3panel-xy")).toBe("xy-main");
  });

  it("still reject a name nobody registered", () => {
    expect(() => layouts.validateLayoutName("3panel-yz")).toThrow(
      /Invalid layout name/,
    );
  });

  it("put the three sections side by side, equally wide", () => {
    expect(layouts.threePanelColumns("row")).toEqual([
      { flex: 1, panels: ["xy"] },
      { flex: 1, panels: ["xz"] },
      { flex: 1, panels: ["yz"] },
    ]);
  });

  it("give XY two thirds of the width, with XZ over YZ beside it", () => {
    expect(layouts.threePanelColumns("xy-main")).toEqual([
      { flex: 2, panels: ["xy"] },
      { flex: 1, panels: ["xz", "yz"] },
    ]);
  });

  it("leave the existing layouts in place", () => {
    for (const name of ["4panel", "4panel-alt", "3d", "xy", "xy-3d"]) {
      expect(layouts.validateLayoutName(name)).toBe(name);
    }
  });
});
