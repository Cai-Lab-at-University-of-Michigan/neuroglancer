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
 * BUG-124, reproduced by Scott 2026-08-26: a scribble or lasso drag started on
 * the minimap drew on the minimap, then jumped the viewport on release, and if
 * the pointer was over the image when he let go, painted onto the image.
 *
 * The minimap is appended into the panel element (custom/minimap.ts), so a
 * predicate built on closest() called it "on the image".
 */

import { describe, expect, it } from "vitest";

import { DATA_PANEL_SELECTOR, isOnDataPanel } from "#src/custom/panel_hit.js";

/**
 * The class Neuroglancer actually puts on a panel
 * (rendered_data_panel.ts: element.classList.add(...)).
 *
 * ⚠️ Written out rather than derived from DATA_PANEL_SELECTOR. Deriving it made
 * every test here pass with a typo in the constant, because the fixture then
 * carried the same typo -- caught by mutating the selector, which is the one
 * thing in this module that ties it to the real DOM.
 */
const REAL_PANEL_CLASS = "neuroglancer-rendered-data-panel";

/** A data panel with a control layered over it, the way the viewer builds one. */
function panelWithChild() {
  const panel = document.createElement("div");
  panel.className = REAL_PANEL_CLASS;
  const minimap = document.createElement("div");
  minimap.className = "neuroglancer-minimap-container";
  const canvasInsideMinimap = document.createElement("canvas");
  minimap.appendChild(canvasInsideMinimap);
  panel.appendChild(minimap);
  return { panel, minimap, canvasInsideMinimap };
}

describe("what counts as a click on the image", () => {
  it("targets the class Neuroglancer really uses", () => {
    expect(DATA_PANEL_SELECTOR).toBe(`.${REAL_PANEL_CLASS}`);
  });

  it("says yes to the panel itself", () => {
    const { panel } = panelWithChild();
    expect(isOnDataPanel({ target: panel })).toBe(true);
  });

  it("says NO to a control layered over the panel", () => {
    // The bug. closest() walks up and answers "somewhere inside a panel",
    // which is true of every control drawn on top of the image.
    const { minimap } = panelWithChild();
    expect(isOnDataPanel({ target: minimap })).toBe(false);
  });

  it("says NO to something nested deeper inside that control", () => {
    // The minimap's own canvas is where its mousedown listener lives, so this
    // is the element the browser actually reports for Scott's drag.
    const { canvasInsideMinimap } = panelWithChild();
    expect(isOnDataPanel({ target: canvasInsideMinimap })).toBe(false);
  });

  it("says no to an element outside any panel", () => {
    expect(isOnDataPanel({ target: document.createElement("div") })).toBe(
      false,
    );
  });

  it("says no rather than throwing when there is no target", () => {
    // Reachable: a synthesised event, or one whose target has already been
    // detached. Throwing here would take out the whole mousedown handler.
    expect(isOnDataPanel({ target: null })).toBe(false);
    expect(isOnDataPanel({ target: document })).toBe(false);
  });
});
