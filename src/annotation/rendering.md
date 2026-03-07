# Annotation rendering

Annotation rendering can be customized using GLSL shader code.

## Shader language

The shader code must conform to the OpenGL ES Shading Language (GLSL) version 3.0, specified at <https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>.

You may find the WebGL reference card helpful: <https://www.khronos.org/files/webgl20-reference-guide.pdf>.

## UI Controls

[UI control directives](../sliceview/image_layer_rendering.md#ui-controls) are supported as for image layers.

## API

### Accessing annotation properties

To retrieve a property named `myProperty`, use the syntax `prop_myProperty()`.

### Common API

```glsl
const bool PROJECTION_VIEW;
```

Set to `true` when rendering a 3-d projection view, set to `false` when rendering a cross section view.

```glsl
discard;
```

Discards the annotation from rendering (the annotation won't be shown). Use the syntax `discard;`, not `discard();`.

```glsl
void setColor(vec4 color) {
  setPointMarkerColor(color);
  setLineColor(color);
  setEndpointMarkerColor(color);
  setBoundingBoxBorderColor(color);
  setEllipsoidFillColor(vec4(color.rgb, color.a * (PROJECTION_VIEW ? 1.0 : 0.5)));
}
void setColor(vec3 color) {
  setColor(vec4(color, 1.0));
}
```

Sets the point marker fill color, the line color, the line endpoint marker fill color, the bounding
box border color, and the ellipsoid fill color.

```glsl
vec3 defaultColor();
```

Returns the color set through the "Annotations" tab in the UI, or the `"annotationColor"` member of the layer JSON state. If not accessed in the shader, the corresponding color selector will not be shown in the UI. This behaves similarly to a custom color UI control.

### Type-specific API

The same shader code applies to all annotation types, but API functions specific to a particular
annotation type have no effect when rendering other annotation types.

#### Point annotations

Point annotations are rendered as shapes (circle by default).

```glsl
void setPointMarkerShape(float shapeType);
```

Sets the marker shape. Supported shapes:
- `0` = circle (default)
- `1` = square
- `2` = diamond
- `3` = cross/plus
- `4` = triangle (pointing up)

Example usage:
```glsl
void main() {
  setColor(defaultColor());
  setPointMarkerShape(2.0);  // Diamond shape
}
```

You can also set shape conditionally based on annotation properties:
```glsl
void main() {
  setColor(defaultColor());
  if (prop_cellType() == 1.0) {
    setPointMarkerShape(2.0);  // Diamond for cell type 1
  } else {
    setPointMarkerShape(0.0);  // Circle for others
  }
}
```

```glsl
void setPointMarkerSize(float diameterInScreenPixels);
```

Sets the diameter of the marker in screen pixels (defaults to 3 pixels). The marker maintains a **fixed size on screen** regardless of zoom level - it does not scale with zoom. This provides consistent marker visibility at all zoom levels.

The size value directly corresponds to screen pixels. For example, `setPointMarkerSize(10.0)` will render a marker that is exactly 10 pixels in diameter on your screen.

**Typical range:** 0.5 to 30 pixels (values are clamped to 0.5-100 internally).

Example:
```glsl
void main() {
  setColor(defaultColor());
  setPointMarkerSize(3.0);  // 3-pixel diameter, fixed screen size
}
```

```glsl
void setPointMarkerBorderWidth(float width);
```

Sets the border width (defaults to 0, meaning no border). Range: 0 to 5.

Example with border:
```glsl
void main() {
  setColor(vec4(1.0, 0.0, 0.0, 1.0));  // Red fill
  setPointMarkerBorderWidth(1.5);       // Border width
  setPointMarkerBorderColor(vec4(0.0, 0.0, 0.0, 1.0));  // Black border
}
```

```glsl
void setPointMarkerColor(vec4 rgba);
void setPointMarkerColor(vec3 rgb);
```

Sets the fill color with optional alpha channel (defaults to red #ff0000 with alpha 1.0). May also be set by calling the generic `setColor` function. When using vec4, the alpha component controls fill opacity independently from border opacity.

**Alpha range:** 0.0 (fully transparent) to 1.0 (fully opaque). Values outside this range will be clamped by the GPU.

```glsl
void setPointMarkerBorderColor(vec4 rgba);
void setPointMarkerBorderColor(vec3 rgb);
```

Sets the border color with optional alpha channel (defaults to black #000000 with alpha 1.0). The alpha component controls border opacity independently from fill opacity, allowing for effects like transparent fills with opaque borders or vice versa.

**Alpha range:** 0.0 (fully transparent) to 1.0 (fully opaque). Values outside this range will be clamped by the GPU.

Example with independent alpha control:
```glsl
void main() {
  // Semi-transparent red fill (50% opacity)
  setPointMarkerColor(vec4(1.0, 0.0, 0.0, 0.5));

  // Solid black border (100% opacity)
  setPointMarkerBorderColor(vec4(0.0, 0.0, 0.0, 1.0));
  setPointMarkerBorderWidth(2.0);
}
```

**Comprehensive example** combining all point marker features:
```glsl
void main() {
  // Set marker shape based on annotation property
  float cellType = prop_cellType();
  if (cellType == 1.0) {
    setPointMarkerShape(2.0);  // Diamond for excitatory neurons
  } else if (cellType == 2.0) {
    setPointMarkerShape(4.0);  // Triangle for inhibitory neurons
  } else {
    setPointMarkerShape(0.0);  // Circle for other cell types
  }

  // Fixed 8-pixel marker size (stays same size at all zoom levels)
  setPointMarkerSize(8.0);

  // Semi-transparent blue fill
  setPointMarkerColor(vec4(0.2, 0.5, 1.0, 0.7));

  // Opaque white border for contrast
  setPointMarkerBorderColor(vec4(1.0, 1.0, 1.0, 1.0));
  setPointMarkerBorderWidth(1.5);
}
```

#### Line annotations

Line annotations are rendered as line segments with circles marking the endpoints.

```glsl
void setLineColor(vec4 rgba);
void setLineColor(vec3 rgb);
```

Sets a constant line color (defaults to transparent). May also be set by calling the generic `setColor` function.

```glsl
void setLineColor(vec4 startColor, vec4 endColor);
void setLineColor(vec3 startColor, vec3 endColor);
```

Sets a linear color gradient for the line.

```glsl
void setLineWidth(float widthInScreenPixels);
```

Sets the line width (defaults to 1).

```glsl
void setEndpointMarkerColor(vec4 rgba);
void setEndpointMarkerColor(vec3 rgb);
```

Sets the same fill color for both endpoint markers (defaults to transparent). May also be set by calling the generic `setColor` function.

```glsl
void setEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerColor(vec3 startColor, vec3 endColor);
```

Sets separate fill colors for the endpoint markers.

```glsl
void setEndpointMarkerBorderColor(vec4 rgba);
void setEndpointMarkerBorderColor(vec3 rgb);
```

Sets the same border color for both endpoint markers (defaults to black with alpha 1).

```glsl
void setEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerColor(vec3 startColor, vec3 endColor);
```

Sets separate border colors for the endpoint markers.

```glsl
void setEndpointMarkerSize(float diameter);
```

Sets the same diameter (in screen pixels) for both endpoint markers (defaults to 5 pixels).

```glsl
void setEndpointMarkerSize(float startDiameter, float endDiameter);
```

Sets separate diameters for the endpoint markers.

```glsl
void setEndpointMarkerBorderWidth(float width);
```

Sets the same border width (in screen pixels) for both endpoint markers (defaults to 1 pixel).

```glsl
void setEndpointMarkerBorderWidth(float startWidth, float endWidth);
```

Sets separate border widths for the endpoint markers.

#### Polyline annotations

Polyline annotations are rendered as line segments with circles marking the endpoints. Unlike line annotations, there can be multiple segments.

Polyline annotations follow the same API as line annotations. The default behaviour is that setting a parameter for line annotations will also set the same parameter for polyline annotations. To set a parameter for only the polyline, use the `setPoly` prefix. For example:

```glsl
setLineWidth(2.0);
setPolyLineWidth(4.0);

setEndpointMarkerSize(1.0, 2.0);
setPolyEndpointMarkerSize(3.0, 1.0);
```

All of the names spefically for polylines are as follows for reference, and they have the exact same behaviour as the line annotations (including allowing a reduced set of parameters):

```glsl
void setPolyLineColor(vec4 startColor, vec4 endColor);
void setPolyLineWidth(float width);
void setPolyEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setPolyEndpointMarkerBorderColor(vec4 startColor, vec4 endColor);
void setPolyEndpointMarkerSize(float startSize, float endSize);
void setPolyEndpointMarkerBorderWidth(float startSize, float endSize);
```

#### Bounding box annotations

```glsl
void setBoundingBoxBorderColor(vec4 rgba);
void setBoundingBoxBorderColor(vec3 rgb);
```

Sets the border color (defaults to transparent). May also be set by calling the generic `setColor` function.

```glsl
void setBoundingBoxBorderWidth(float widthInScreenPixels);
```

Sets the border width in screen pixels. Defaults to 1 pixel.

```glsl
void setBoundingBoxFillColor(vec4 rgba);
void setBoundingBoxFillColor(vec3 rgb);
```

Sets the fill color (defaults to transparent). Currently, this only applies to cross-section views.

#### Ellipsoid annotations

```glsl
void setEllipsoidFillColor(vec4 rgba);
void setEllipsoidFillColor(vec3 rgb);
```

Sets the ellipsoid fill color. May also be set by calling the generic `setColor` function.
