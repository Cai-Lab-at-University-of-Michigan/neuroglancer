/**
 * @license
 * Copyright 2018 Google Inc.
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

import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type {
  AnnotationPropertySpec,
  AnnotationSource,
} from "#src/annotation/index.js";
import { propertyTypeDataType } from "#src/annotation/index.js";
import type { LayerDataSource } from "#src/layer/layer_data_source.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import { getChunkTransformParameters } from "#src/render_coordinate_transform.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  registerNested,
  WatchableValue,
} from "#src/trackable_value.js";
import { TrackableRGB } from "#src/util/color.js";
import type { DataType } from "#src/util/data_type.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { vec3 } from "#src/util/geom.js";
import { WatchableMap } from "#src/util/watchable_map.js";
import {
  makeTrackableFragmentMain,
  makeWatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import {
  getFallbackBuilderState,
  parseShaderUiControls,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";

export class AnnotationHoverState extends WatchableValue<
  | {
      id: string;
      partIndex: number;
      annotationLayerState: AnnotationLayerState;
    }
  | undefined
> {}

// null means loading
// undefined means no attached layer
export type OptionalSegmentationDisplayState =
  | SegmentationDisplayState
  | null
  | undefined;

export interface AnnotationRelationshipState {
  segmentationState: WatchableValueInterface<OptionalSegmentationDisplayState>;
  showMatches: TrackableBoolean;
}

export class WatchableAnnotationRelationshipStates extends WatchableMap<
  string,
  AnnotationRelationshipState
> {
  constructor() {
    super((context, { showMatches, segmentationState }) => {
      context.registerDisposer(showMatches.changed.add(this.changed.dispatch));
      context.registerDisposer(
        segmentationState.changed.add(this.changed.dispatch),
      );
      context.registerDisposer(
        registerNested((nestedContext, segmentationState) => {
          if (segmentationState == null) return;
          const { segmentationGroupState } = segmentationState;
          nestedContext.registerDisposer(
            segmentationGroupState.changed.add(this.changed.dispatch),
          );
          nestedContext.registerDisposer(
            registerNested((groupContext, groupState) => {
              const { visibleSegments } = groupState;
              let wasEmpty = visibleSegments.size === 0;
              groupContext.registerDisposer(
                visibleSegments.changed.add(() => {
                  const isEmpty = visibleSegments.size === 0;
                  if (isEmpty !== wasEmpty) {
                    wasEmpty = isEmpty;
                    this.changed.dispatch();
                  }
                }),
              );
            }, segmentationGroupState),
          );
        }, segmentationState),
      );
    });
  }

  get(name: string): AnnotationRelationshipState {
    let value = super.get(name);
    if (value === undefined) {
      value = {
        segmentationState: new WatchableValue(undefined),
        showMatches: new TrackableBoolean(false),
      };
      super.set(name, value);
    }
    return value;
  }
}

const DEFAULT_FRAGMENT_MAIN = `
void main() {
  setColor(defaultColor());
}
`;

export class AnnotationDisplayState extends RefCounted {
  annotationProperties = new WatchableValue<
    AnnotationPropertySpec[] | undefined
  >(undefined);
  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControls = new ShaderControlState(
    this.shader,
    makeCachedLazyDerivedWatchableValue((annotationProperties) => {
      const properties = new Map<string, DataType>();
      if (annotationProperties === undefined) {
        return null;
      }
      for (const property of annotationProperties) {
        const dataType = propertyTypeDataType[property.type];
        if (dataType === undefined) continue;
        properties.set(property.identifier, dataType);
      }
      return { properties };
    }, this.annotationProperties),
  );
  fallbackShaderControls = new WatchableValue(
    getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
  );
  shaderError = makeWatchableShaderError();
  color = new TrackableRGB(vec3.fromValues(1, 1, 0));
  relationshipStates = this.registerDisposer(
    new WatchableAnnotationRelationshipStates(),
  );
  ignoreNullSegmentFilter = new TrackableBoolean(true);
  disablePicking = new WatchableValue(false);
  /**
   * How far from its own slice an annotation in THIS layer stays visible, and
   * how sharply it dims on the way there. See annotation/slice_fade.ts.
   *
   * ⚠️ `sliceFadeSlices = 0` means OFF, and off is the default, because most
   * annotation layers are not prompts. A spot-detection point cloud is an
   * annotation layer too, and culling it a few slices from the current one
   * would silently take a working feature away from the people using it. Only
   * a layer that opts in fades; everything else renders exactly as it did
   * before the fade existed.
   *
   * Do not read `0` here as "the same test as `ng_sliceFade <= 0.0` in the
   * shader". That one means this annotation is beyond the range and must not be
   * drawn. This one means the layer has no range at all.
   */
  sliceFadeSlices = new WatchableValue<number>(0);
  sliceFadeCurve = new WatchableValue<number>(1);
  displayUnfiltered = makeCachedLazyDerivedWatchableValue(
    (map, ignoreNullSegmentFilter) => {
      for (const state of map.values()) {
        if (state.showMatches.value) {
          if (!ignoreNullSegmentFilter) return false;
          const segmentationState = state.segmentationState.value;
          if (segmentationState != null) {
            if (
              segmentationState.segmentationGroupState.value.visibleSegments
                .size > 0
            ) {
              return false;
            }
          }
        }
      }
      return true;
    },
    this.relationshipStates,
    this.ignoreNullSegmentFilter,
  );
  hoverState = new AnnotationHoverState(undefined);
}

export class AnnotationLayerState extends RefCounted {
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  localPosition: WatchableValueInterface<Float32Array>;
  source: Owned<AnnotationSource | MultiscaleAnnotationSource>;
  role: RenderLayerRole;
  dataSource: LayerDataSource;
  subsourceId: string;
  subsourceIndex: number;
  displayState: AnnotationDisplayState;
  subsubsourceId?: string;

  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;

  constructor(options: {
    transform: WatchableValueInterface<RenderLayerTransformOrError>;
    localPosition: WatchableValueInterface<Float32Array>;
    source: Owned<AnnotationSource | MultiscaleAnnotationSource>;
    displayState: AnnotationDisplayState;
    dataSource: LayerDataSource;
    subsourceId: string;
    subsourceIndex: number;
    subsubsourceId?: string;
    role?: RenderLayerRole;
  }) {
    super();
    const {
      transform,
      localPosition,
      source,
      role = RenderLayerRole.ANNOTATION,
    } = options;
    this.transform = transform;
    this.localPosition = localPosition;
    this.source = this.registerDisposer(source);
    this.role = role;
    this.displayState = options.displayState;
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        this.transform,
      ),
    );
    this.dataSource = options.dataSource;
    this.subsourceId = options.subsourceId;
    this.subsourceIndex = options.subsourceIndex;
    this.subsubsourceId = options.subsubsourceId;
  }

  get sourceIndex() {
    const { dataSource } = this;
    return dataSource.layer.dataSources.indexOf(dataSource);
  }
}
