/**
 * How far from its own slice an annotation stays visible.
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
 * ⚠️ These are deliberately global rather than per layer: one behaviour, one
 * number, decided 2026-08-25.
 *
 * ⚠️ They are also FIXED, with nothing able to change them at runtime. A pair of
 * panel controls existed while these values were being chosen and was removed
 * once they were: the numbers below are what that tuning settled on, so the
 * control had done its job. Both remain uniforms rather than GLSL literals
 * because that is the seam a future per-scene or per-layer value would use --
 * source them from AnnotationDisplayState (annotation_layer_state.ts already
 * holds per-layer WatchableValues) and neither the shader nor the upload
 * changes.
 *
 * ⚠️ IF YOU MAKE THESE SETTABLE AGAIN, SUBSCRIBE TO THEM. A value that can
 * change but that AnnotationLayer does not listen to repaints only when
 * something else happens to trigger a frame, which from the user's side is
 * indistinguishable from the control being dead. That subscription lived in
 * renderlayer.ts and went with the controls; putting the setter back without it
 * is the trap this paragraph exists to prevent.
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
 */
export const sliceFadeSlices = 5;

/** Exponent on the fade. 1 is linear, and 1 is what the tuning settled on.
 *  Changing the SHAPE of the curve is a one-line edit in getSliceFadeFactor,
 *  not a change here. */
export const sliceFadeCurve = 1;
