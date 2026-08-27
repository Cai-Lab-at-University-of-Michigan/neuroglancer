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
 * Is this event on the image itself, as opposed to a control sitting over it?
 *
 * Its own module because drawing_tool_handler.ts reaches WebGL on import, so
 * nothing in it can be unit tested, and this predicate decides whether the
 * drawing tool takes a mousedown at all.
 */

export const DATA_PANEL_SELECTOR = ".neuroglancer-rendered-data-panel";

/**
 * True only when the event landed on a data panel ITSELF.
 *
 * ⚠️ Deliberately not `closest()`, and BUG-124 is what that cost. `closest()`
 * walks up, so it answers "is this somewhere inside a panel", which is true of
 * every control layered over the image -- the minimap
 * (custom/minimap.ts appends it straight into the panel element), the
 * display-dimensions widget, the scale bar. The drawing tool would then take a
 * mousedown on the minimap, start a stroke, and stop the event, so the minimap
 * never saw the press and only jumped on the click that followed.
 *
 * `=== element` is also what Neuroglancer itself uses to decide whether the
 * mouse is on a panel (rendered_data_panel.ts: onMousemove returns early on
 * `event.target !== element`, and a capture-phase mouseover calls onMouseout()
 * for any child). Those two disagreeing is the whole defect: we thought we were
 * on the image while Neuroglancer had already stopped tracking the mouse, so
 * the coordinates a stroke recorded were stale.
 *
 * The panel element really is the target in the ordinary case -- the WebGL
 * canvas is shared at display level and the panels are positioned divs over it,
 * which is why Neuroglancer's own navigation works with the same test.
 *
 * ⚠️ Do NOT apply this to the two gates in drawing_tool_handler.ts that BLOCK
 * navigation while the view is locked (`isOnSliceViewPanel`, and the arrow-key
 * blocker). Broad is correct there: blocking a little too much while locked is
 * the safe direction, and narrowing them would let a drag on a child pan a
 * locked view.
 */
export function isOnDataPanel(e: { target: EventTarget | null }): boolean {
  const target = e.target as Element | null;
  if (!target || typeof target.matches !== "function") return false;
  return target.matches(DATA_PANEL_SELECTOR);
}
