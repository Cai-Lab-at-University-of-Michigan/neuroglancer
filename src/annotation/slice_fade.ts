/**
 * How far from its own slice a PROMPT stays visible.
 *
 * An annotation is drawn on one slice. Neuroglancer's own cross-section fade is
 * scaled to the slice view's depth range rather than to the data, which is deep
 * enough that scrolling away barely dims anything, and its per-dimension clip is
 * switched off for every displayed dimension -- so a mark drawn on one slice
 * stayed fully legible on all of them. For a prompt that is not a cosmetic
 * problem: a prompt is the input the user gave the model on one layer, and
 * showing it identically everywhere says the model was given something it was
 * not.
 *
 * Two knobs, because they answer different questions and conflating them is the
 * likeliest tuning frustration:
 *
 *   slices   how FAR. Beyond this many slices the annotation is not drawn at
 *            all, and not picked either.
 *   curve    how FAST it dims on the way there: fade = (1 - d/slices)^curve.
 *            Raising `slices` alone also makes the neighbouring slices look
 *            more like the current one; the exponent is what buys back the
 *            distinction. 1 is linear, 2 dims a neighbour to 64% where linear
 *            leaves it at 80%.
 *
 * ⚠️ THESE ARE THE PROMPT LAYERS' VALUES, NOT A GLOBAL SETTING. The fade is off
 * for every annotation layer unless that layer opts in, and the only thing that
 * opts anything in is getPromptAnnotationSource in custom/drawing_tool_handler.ts.
 * The live value is per layer, on AnnotationDisplayState
 * (annotation/annotation_layer_state.ts); these two constants are just what the
 * prompt layers are set to.
 *
 * That distinction is the whole of finding F1 in the 2026-08-25 review, and it
 * is not hypothetical: SAVAII generates spot-detection point clouds as
 * annotation layers (backend/app/plugins/ng/settings/state_gen.py, "Generate an
 * annotation layer configuration for pointclouds"), so a global fade would have
 * culled a researcher's whole point cloud a few slices from the current one,
 * with nothing on screen to say why and no control to turn it back. Making it
 * per layer means we never have to decide whether that would have been an
 * improvement -- we simply do not touch it.
 *
 * ⚠️ There is no runtime control. A pair of panel controls existed while these
 * values were being chosen and was removed once they were. IF YOU MAKE THEM
 * SETTABLE AGAIN, the per-layer WatchableValues are already subscribed to
 * redrawNeeded in renderlayer.ts, so a setter is all that is missing -- but
 * check that subscription is still there, because a value that can change while
 * nothing listens repaints only when something else happens to cause a frame,
 * which looks exactly like a dead control.
 */

/**
 * Measured on a 1024x1024x1022 dataset: scrolling one direction until a seed
 * disappeared took 36 slices at normal annotating zoom, 16 zoomed in until half
 * the area was visible, and 60 zoomed out. The tightest is 16, so 5 leaves
 * roughly threefold headroom before the cross-section slab itself would clip
 * (mat4.ortho with +/-relativeDepthRange, sliceview/frontend.ts, fed by
 * crossSectionDepthRange, default -10 in viewer.ts).
 *
 * ⚠️ That was approximately isotropic data. Extreme anisotropy -- thick Z
 * voxels -- combined with extreme magnification was NOT tested, and there the
 * slab could clip before this fade does. No defensive code for it on purpose;
 * this note exists so that a report of "the fade turned into a hard cut-off"
 * points at the slab rather than at the formula.
 *
 * Worth knowing: a hard cut-off already existed before this fade, at around 36
 * slices. Nobody had scrolled that far, which is why "it shows on every layer"
 * and "the slab is finite" were both true at once. This pulls the cut-off in to
 * `slices` and turns it into a gradient.
 *
 * ⚠️ ANISOTROPY PLUS AN OBLIQUE CROSS-SECTION DOES NOT MEASURE ONE SLICE PER
 * CLICK, and the honest version of this note took two passes to get right. Two
 * separate effects, in opposite directions, and the second is the bigger one.
 *
 * The formula. The distance is measured along the view normal, and the voxel
 * factors cancel exactly only when the cross-section is axis-aligned. Rotate it
 * and a unit step along the normal reads
 *
 *     (sin^2 t + A cos^2 t) / sqrt(sin^2 t + A^2 cos^2 t)
 *
 * for anisotropy A in z and rotation t. By Cauchy-Schwarz that is at most 1,
 * worst at t = atan(sqrt(A)) where it is 2*sqrt(A)/(1+A): 0.866 at A = 3, and
 * 0.629 at A = 8. Taken alone this says the fade is always too generous.
 *
 * ⚠️ TAKEN ALONE IT IS ALSO MISLEADING, because that unit step is never the
 * step. translateVoxelsRelative (navigation_state.ts) puts every display
 * coordinate through clampAndRoundCoordinateToVoxelCenter, so the camera snaps
 * to a unit lattice after each wheel click and the ideal step is unreachable
 * whenever the normal is not a chunk axis. What a user actually gets:
 *
 *     A = 8, t = 30 deg   formula 0.900   per click 0.997   gone after 6 clicks
 *     A = 3, t = 45 deg   formula 0.894   per click 1.265   gone after 4 clicks
 *     A = 3, t = 60 deg   formula 0.866   per click 1.366   gone after 4 clicks
 *     A = 1, t = 45 deg   formula 1.000   per click 1.414   gone after 4 clicks
 *
 * Read the last row first. ⚠️ IT NEEDS NO ANISOTROPY AT ALL: with cubic voxels
 * and a 45 degree rotation the ideal step (0, -0.7071, 0.7071) rounds to
 * (0, -1, 1), which is sqrt(2) long, so a click covers 1.414 slices and the
 * annotation is culled one click early. The rounding is the bigger effect, it
 * usually points the other way from the formula, and rotation alone is enough
 * to cause it. "Always errs toward surviving too far" is true of the formula
 * and false of the viewer, and only the second is what anybody sees.
 *
 * All eight figures are pinned in slice_fade.spec.ts, which is where they were
 * corrected: the first draft of this paragraph had the A=3, t=60 figure at 0.5
 * because it was computed in Python, whose round() breaks ties to even while
 * Math.round does not.
 *
 * A sheared layer transform does the same thing with no rotation at all, so
 * "oblique" really means "the view normal is not a chunk axis", of which
 * rotation is one route.
 *
 * None of it is reachable from SAVAII today -- the embedded viewer offers no
 * way to rotate a cross-section, which is why browser check 13 could not be run
 * on 2026-08-25. No defensive code, on purpose.
 */
export const sliceFadeSlices = 5;

/** Exponent on the fade. 1 is linear, and 1 is what the tuning settled on.
 *  Changing the SHAPE of the curve is a one-line edit in getSliceFadeFactor,
 *  not a change here. */
export const sliceFadeCurve = 1;
