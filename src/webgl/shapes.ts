/**
 * @license
 * Copyright 2017 Google Inc.
 * Copyright 2026 Bin Duan
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
 *
 * Modifications by Bin Duan:
 * - Added border color and width support for point markers
 * - Added independent alpha channel control for fill and border colors
 * - Fixed triangle SDF to prevent top clipping
 */

/**
 * @file Facilities for drawing point marker shapes in WebGL as quads.
 *
 * Supported shapes:
 *   0 = circle (default)
 *   1 = square
 *   2 = diamond
 *   3 = cross/plus
 *   4 = triangle (pointing up)
 */

import {
  drawQuads,
  glsl_getQuadVertexPosition,
  VERTICES_PER_QUAD,
} from "#src/webgl/quad.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export const VERTICES_PER_SHAPE = VERTICES_PER_QUAD;

export function defineShapeShader(
  builder: ShaderBuilder,
  crossSectionFade: boolean,
) {
  builder.addVertexCode(glsl_getQuadVertexPosition);
  // x and y components: The x and y radii of the point in normalized device coordinates.
  // z component: Starting point of border from [0, 1].
  // w component: Fraction of total radius that is feathered.
  builder.addUniform("highp vec3", "uShapeParams");

  // 2-D position within shape quad, ranging from [-1, -1] to [1, 1].
  builder.addVarying("highp vec4", "vShapeCoord");
  // Shape type: 0=circle, 1=square, 2=diamond, 3=cross, 4=triangle
  builder.addVarying("highp float", "vShapeType");

  builder.addVertexCode(`
void emitShape(vec4 position, float diameter, float borderWidth, float shapeType) {
  gl_Position = position;
  float totalDiameter = diameter + 2.0 * (borderWidth + uShapeParams.z);
  if (diameter == 0.0) totalDiameter = 0.0;
  vec2 shapeCornerOffset = getQuadVertexPosition(vec2(-1.0, -1.0), vec2(1.0, 1.0));
  gl_Position.xy += shapeCornerOffset * uShapeParams.xy * gl_Position.w * totalDiameter;
  vShapeCoord.xy = shapeCornerOffset;
  if (borderWidth == 0.0) {
    vShapeCoord.z = totalDiameter;
    vShapeCoord.w = 1e-6;
  } else {
    vShapeCoord.z = diameter / totalDiameter;
    vShapeCoord.w = uShapeParams.z / totalDiameter;
  }
  vShapeType = shapeType;
}
`);

  if (crossSectionFade) {
    builder.addFragmentCode(`
float getShapeAlphaMultiplier() {
  // Fade based on depth, but with a minimum floor to prevent complete disappearance
  float fade = 1.0 - 2.0 * abs(0.5 - gl_FragCoord.z);
  return max(fade, 0.15);  // Keep at least 15% visibility
}
`);
  } else {
    builder.addFragmentCode(`
float getShapeAlphaMultiplier() {
  return 1.0;
}
`);
  }

  // Shape distance field functions
  builder.addFragmentCode(`
// Distance functions for different shapes
// All return values in [0, 1] range where:
//   0 = center of shape
//   1 = edge of shape (boundary)
//   >1 = outside shape (will be discarded)

float sdCircle(vec2 p) {
  return length(p);
}

float sdSquare(vec2 p) {
  // Chebyshev distance (L-infinity norm)
  return max(abs(p.x), abs(p.y));
}

float sdDiamond(vec2 p) {
  // Manhattan distance (L1 norm) - diamond corners at (±1,0) and (0,±1)
  return abs(p.x) + abs(p.y);
}

float sdCross(vec2 p) {
  // Cross/plus shape as union of two perpendicular bars
  vec2 q = abs(p);
  float armWidth = 0.35;

  // Check if point is inside vertical bar (|x| < armWidth)
  // or inside horizontal bar (|y| < armWidth)
  bool inVertBar = q.x < armWidth;
  bool inHorzBar = q.y < armWidth;

  if (inVertBar && inHorzBar) {
    // Center intersection - blend both distances
    return max(q.x, q.y);
  } else if (inVertBar) {
    // Inside vertical bar only - distance based on y
    return q.y;
  } else if (inHorzBar) {
    // Inside horizontal bar only - distance based on x
    return q.x;
  }

  // Outside cross entirely
  return 2.0;
}

float sdTriangle(vec2 p) {
  // Equilateral triangle pointing up, properly scaled to fit in [-1, 1] bounds
  // Scale down to ensure no clipping
  p *= 1.15;  // Scale up input to make triangle fit bounds

  // Equilateral triangle centered at origin, pointing up
  // Vertices: (0, 0.866), (-0.866, -0.433), (0.866, -0.433)
  const float k = sqrt(3.0);
  p.x = abs(p.x);  // Mirror to right side

  // Distance to bottom edge (horizontal line at y = -0.577)
  p.y += 0.577;

  // Check if point is below the two slanted edges
  if (p.x * k + p.y < 0.0) {
    // Reflect point across the slanted edge
    p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }

  // Distance to bottom-left edge
  p.x -= clamp(p.x, 0.0, 1.0);

  // Calculate distance and normalize to [0, 1] range
  float dist = length(p) * sign(p.y);
  return abs(dist) / 1.15;  // Compensate for initial scaling
}

float getShapeDistance(vec2 p, float shapeType) {
  int shape = int(shapeType + 0.5);  // Round to nearest int
  if (shape == 1) return sdSquare(p);
  if (shape == 2) return sdDiamond(p);
  if (shape == 3) return sdCross(p);
  if (shape == 4) return sdTriangle(p);
  return sdCircle(p);  // Default: circle
}

vec4 getShapeColor(vec4 interiorColor, vec4 borderColor) {
  float dist = getShapeDistance(vShapeCoord.xy, vShapeType);
  if (dist > 1.0) {
    discard;
  }

  float borderColorFraction = clamp((dist - vShapeCoord.z) / vShapeCoord.w, 0.0, 1.0);
  float feather = clamp((1.0 - dist) / vShapeCoord.w, 0.0, 1.0);
  vec4 color = mix(interiorColor, borderColor, borderColorFraction);

  return vec4(color.rgb, color.a * feather * getShapeAlphaMultiplier());
}
`);
}

export function initializeShapeShader(
  shader: ShaderProgram,
  projectionParameters: { width: number; height: number },
  options: { featherWidthInPixels: number },
) {
  const { gl } = shader;
  gl.uniform3f(
    shader.uniform("uShapeParams"),
    1 / projectionParameters.width,
    1 / projectionParameters.height,
    Math.max(1e-6, options.featherWidthInPixels),
  );
}

export function drawShapes(
  gl: WebGL2RenderingContext,
  shapesPerInstance: number,
  numInstances: number,
) {
  drawQuads(gl, shapesPerInstance, numInstances);
}
