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
 * The minimap's "Contrast" setting always drove CSS brightness(). It is now
 * labelled Brightness, and a real contrast sits beside it. The old message
 * type keeps meaning brightness, because frontends already deployed send it
 * with a brightness value.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  applyThumbnailToneMessage,
  getThumbnailTone,
  thumbnailToneFilter,
} from "#src/custom/minimap.js";

describe("minimap thumbnail tone", () => {
  beforeEach(() => {
    applyThumbnailToneMessage({ type: "thumbnail_contrast", value: 1 });
    applyThumbnailToneMessage({ type: "thumbnail_true_contrast", value: 1 });
  });

  it("reads the old thumbnail_contrast message as brightness", () => {
    expect(
      applyThumbnailToneMessage({ type: "thumbnail_contrast", value: 2 }),
    ).toBe(true);
    expect(getThumbnailTone()).toEqual({ brightness: 2, contrast: 1 });
    expect(thumbnailToneFilter(getThumbnailTone())).toBe("brightness(2)");
  });

  it("reads thumbnail_true_contrast as contrast, leaving brightness alone", () => {
    applyThumbnailToneMessage({ type: "thumbnail_contrast", value: 1.5 });
    expect(
      applyThumbnailToneMessage({ type: "thumbnail_true_contrast", value: 3 }),
    ).toBe(true);
    expect(getThumbnailTone()).toEqual({ brightness: 1.5, contrast: 3 });
    expect(thumbnailToneFilter(getThumbnailTone())).toBe(
      "brightness(1.5) contrast(3)",
    );
  });

  it("changing brightness leaves contrast alone", () => {
    applyThumbnailToneMessage({ type: "thumbnail_true_contrast", value: 0.5 });
    applyThumbnailToneMessage({ type: "thumbnail_contrast", value: 2.5 });
    expect(getThumbnailTone()).toEqual({ brightness: 2.5, contrast: 0.5 });
    expect(thumbnailToneFilter(getThumbnailTone())).toBe(
      "brightness(2.5) contrast(0.5)",
    );
  });

  it("applies no filter at the identity tone", () => {
    expect(thumbnailToneFilter({ brightness: 1, contrast: 1 })).toBe("none");
    expect(thumbnailToneFilter({ brightness: 1, contrast: 2 })).toBe(
      "contrast(2)",
    );
  });

  it("keeps the current value when a message carries no usable number", () => {
    applyThumbnailToneMessage({ type: "thumbnail_contrast", value: 2 });
    applyThumbnailToneMessage({ type: "thumbnail_true_contrast", value: 3 });
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      expect(
        applyThumbnailToneMessage({ type: "thumbnail_contrast", value }),
      ).toBe(true);
      expect(
        applyThumbnailToneMessage({ type: "thumbnail_true_contrast", value }),
      ).toBe(true);
    }
    expect(getThumbnailTone()).toEqual({ brightness: 2, contrast: 3 });
  });

  it("does not claim messages of any other type", () => {
    expect(
      applyThumbnailToneMessage({ type: "thumbnail_clear", value: 9 }),
    ).toBe(false);
    expect(applyThumbnailToneMessage({ type: "reset_view" })).toBe(false);
    expect(getThumbnailTone()).toEqual({ brightness: 1, contrast: 1 });
  });
});
