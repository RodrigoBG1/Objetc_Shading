// =============================================================================
// shader.wgsl  --  Object-order graphics pipeline
//
// render_mode values (global, same for all objects):
//   0  Gouraud      per-vertex lighting, interpolated colour
//   1  Phong        per-fragment lighting
//   2  Normal buf   world-space normals as RGB  (R=X G=Y B=Z, remapped 0..1)
//   3  Wireframe    black edges on white fill, hidden surfaces via z-buffer
//   4  Depth        linear depth greyscale
//   5  Texture      texture x Phong lighting
//   6  UV coords    u->R  v->G  0->B  (black=0,0  red=1,0  green=0,1  yellow=1,1)
//
// Per-object uniform buffer -- one per SceneObject instance.
// =============================================================================

struct Uniforms {
  mvp         : mat4x4<f32>,   // Model-View-Projection
  model       : mat4x4<f32>,   // Model -> World
  normalMat   : mat4x4<f32>,   // transpose(inverse(model))
  view        : mat4x4<f32>,   // View matrix

  lightPos    : vec3<f32>,
  _p0         : f32,

  lightColor  : vec3<f32>,
  _p1         : f32,

  ambient     : f32,
  diffuse     : f32,
  specular    : f32,
  shininess   : f32,

  camPos      : vec3<f32>,
  render_mode : u32,

  objectColor : vec3<f32>,
  use_texture : u32,

  time        : f32,
  is_selected : u32,   // 1 = draw selection outline tint
  _p2         : f32,
  _p3         : f32,
};

@group(0) @binding(0) var<uniform> u        : Uniforms;
@group(0) @binding(1) var          tex_samp : sampler;
@group(0) @binding(2) var          tex_img  : texture_2d<f32>;

// -- Vertex I/O ----------------------------------------------------------------
// Stride: [pos3, norm3, bary3, uv2]  --  11 floats = 44 bytes
struct VSIn {
  @location(0) position    : vec3<f32>,
  @location(1) normal      : vec3<f32>,
  @location(2) barycentric : vec3<f32>,
  @location(3) uv          : vec2<f32>,
};

struct VSOut {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) worldPos      : vec3<f32>,
  @location(1) worldNormal   : vec3<f32>,
  @location(2) barycentric   : vec3<f32>,
  @location(3) uv            : vec2<f32>,
  @location(4) gouraudColor  : vec3<f32>,
  @location(5) depth         : f32,
};

// -- Lighting ------------------------------------------------------------------
// Blinn-Phong: uses half-vector H for specular (avoids mirror reflection issues)
fn phongLight(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>) -> vec3<f32> {
  let L = normalize(u.lightPos - worldPos);
  let V = normalize(u.camPos   - worldPos);

  let ambientC = u.ambient * u.lightColor;
  let NdotL    = max(dot(N, L), 0.0);
  let diffuseC = u.diffuse * NdotL * u.lightColor;

  var specC = vec3<f32>(0.0);
  if NdotL > 0.0 {
    let H = normalize(L + V);
    specC = u.specular * pow(max(dot(N, H), 0.0), u.shininess) * u.lightColor;
  }
  return (ambientC + diffuseC + specC) * baseColor;
}

// -- Vertex shader -------------------------------------------------------------
@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;

  let wp4 = u.model     * vec4<f32>(in.position, 1.0);
  let wn4 = u.normalMat * vec4<f32>(in.normal,   0.0);

  out.clipPos     = u.mvp * vec4<f32>(in.position, 1.0);
  out.worldPos    = wp4.xyz;
  out.worldNormal = normalize(wn4.xyz);
  out.barycentric = in.barycentric;
  out.uv          = in.uv;
  out.depth       = out.clipPos.z / out.clipPos.w;

  // Gouraud: compute lighting per-vertex so the fragment shader just reads it
  if u.render_mode == 0u {
    out.gouraudColor = phongLight(out.worldNormal, out.worldPos, u.objectColor);
  } else {
    out.gouraudColor = vec3<f32>(0.0);
  }

  return out;
}

// -- Fragment shader -----------------------------------------------------------
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let N = normalize(in.worldNormal);

  // Base colour: object colour, optionally modulated by texture
  var baseColor = u.objectColor;
  if u.use_texture == 1u {
    baseColor = baseColor * textureSample(tex_img, tex_samp, in.uv).rgb;
  }

  var color: vec3<f32>;

  switch u.render_mode {

    // Gouraud: colour was computed per-vertex and interpolated by GPU
    case 0u: {
      color = in.gouraudColor;
      if u.use_texture == 1u {
        color = color * textureSample(tex_img, tex_samp, in.uv).rgb;
      }
    }

    // Phong: per-fragment lighting with interpolated normals
    case 1u: {
      color = phongLight(N, in.worldPos, baseColor);
    }

    // Normal buffer: remap world-space normals [-1,1] -> [0,1]
    case 2u: {
      color = N * 0.5 + vec3<f32>(0.5);
    }

    // Wireframe: black edges on white fill via barycentric edge detection
    case 3u: {
      let edge = min(in.barycentric.x, min(in.barycentric.y, in.barycentric.z));
      let wire = 1.0 - smoothstep(0.0, 0.018, edge);
      let grey = 1.0 - wire;   // white fill, black edge
      color = vec3<f32>(grey);
    }

    // Depth: linear NDC depth remapped to [0,1] greyscale
    case 4u: {
      let d = (in.depth + 1.0) * 0.5;
      color = vec3<f32>(d);
    }

    // Texture x Phong: sample texture, multiply by Phong lighting
    case 5u: {
      let tc = textureSample(tex_img, tex_samp, in.uv).rgb;
      color = phongLight(N, in.worldPos, tc);
    }

    // UV coords visualised as colour: U->Red, V->Green
    default: {
      color = vec3<f32>(in.uv.x, in.uv.y, 0.0);
    }
  }

  // Selection tint: brighten slightly when this object is selected
  if u.is_selected == 1u {
    color = color + vec3<f32>(0.08, 0.08, 0.0);
  }

  return vec4<f32>(color, 1.0);
}
