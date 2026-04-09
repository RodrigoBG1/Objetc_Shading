# 🎓 Midterm Project — Object-Order Graphics Pipeline (WebGPU)

## Project Overview

This is a WebGPU-based 3D graphics pipeline built with **TypeScript + Vite**. The project already has a working foundation. Your task is to extend and complete it according to the requirements below.

---

## Project Structure

```
├── public/
│   └── models/          ← Place .obj files here (beacon.obj, teapot.obj, etc.)
├── src/
│   ├── camera.ts        ← Arcball / orbit camera controller
│   ├── main.ts          ← App entry point: WebGPU init, scene loop, GUI wiring
│   ├── math.ts          ← Vec3 + Mat4 utilities (already complete)
│   ├── shader.wgsl      ← WGSL vertex + fragment shaders
│   └── style.css        ← GUI overlay styles (already complete)
├── index.html
├── package.json
└── tsconfig.json
```

> **All model files (`beacon.obj`, `teapot.obj`, etc.) must be placed inside `public/models/`** so Vite serves them at `/models/<filename>`.

---

## What Is Already Implemented

- **`math.ts`** — Complete `Vec3` and `Mat4` libraries (dot, cross, normalize, perspective, lookAt, invert, normalMatrix, etc.).
- **`style.css`** — Full GUI panel styling (sliders, buttons, color pickers, checkboxes).
- **`main.ts` (compiled)** — Working WebGPU bootstrap, scene object system, GUI wiring, render loop, procedural sphere & cube generators, OBJ file upload input, and render-mode switching.
- **`shader.wgsl` (embedded)** — All 7 render modes already exist in the shader:
  - `0` Gouraud, `1` Phong, `2` Normal buffer, `3` Wireframe, `4` Depth, `5` Texture, `6` UV coords.
- **Uniform buffer layout** — `mvp`, `model`, `normalMat`, `view`, `lightPos`, `lightColor`, Phong material params, `camPos`, `render_mode`, `objectColor`, `use_texture`, `time`, `is_selected`.
- **Vertex buffer layout** — stride 11 floats: `[pos.xyz | normal.xyz | barycentric.xyz | uv.xy]` (44 bytes).

---

## Tasks to Implement / Complete

Work inside the **`src/`** source files. The compiled output files (`main-*.js`, `math-*.js`) are the reference — do **not** edit them. Rewrite / complete the TypeScript sources instead.

---

### Task 1 — OBJ Mesh Loader (10%)

**File:** `src/main.ts`

Implement `parseOBJ(name: string, text: string): SceneObject`:

- Parse `v`, `vn`, `vt`, and `f` lines from the OBJ text.
- Build an **indexed triangle mesh**: deduplicated vertex list + index array.
- Support both triangles and quads (fan-triangulate quads).
- After loading, compute bounding-sphere center and radius from vertex positions.

```ts
// Expected signature already wired to the file-upload input:
async function parseOBJ(name: string, text: string): Promise<SceneObject>
```

---

### Task 2 — View-Model Transform / Camera Fit (10%)

**File:** `src/camera.ts` and `src/main.ts`

After loading a mesh, auto-fit the camera so the entire object is visible:

| Model  | Bounding sphere center | Radius |
|--------|------------------------|--------|
| beacon | `[125, 125, 125]`      | 125    |
| teapot | `[0.217, 1.575, 0]`    | ~3.6 (derived from bbox `[-3,0,-2]` → `[3.434,3.15,2.0]`) |

- Place the camera at `center + [0, 0, radius * 2.5]`, looking at `center`.
- Set near/far planes to `[radius * 0.01, radius * 10]`.
- Expose a `fitCamera(center, radius)` method on the camera class.

---

### Task 3 — Per-Face & Per-Vertex Normals (10%)

**File:** `src/main.ts` (inside the OBJ loader / mesh builder)

For every triangle in the mesh:

1. **Face normal** = `normalize(cross(v1 - v0, v2 - v0))`.
2. **Vertex normal** = average of all face normals that share that vertex, then normalize.

If the OBJ file already contains `vn` entries use them; otherwise fall back to computed normals.

Store the final normals in the `normal.xyz` slot of the interleaved vertex buffer.

---

### Task 4 — Arcball Camera Controls (35%)

**File:** `src/camera.ts`

Implement a full **arcball / virtual trackball** controller:

- **Mouse drag (no selection)** → orbit the camera around the scene target point.
- **Mouse drag (object selected)** → rotate the selected object around its own center.
- Use the quaternion-based arcball algorithm:
  - Map 2-D screen point to 3-D point on the unit sphere (z from `sqrt(1 - x² - y²)` when inside, hyperbolic outside).
  - Rotation axis = `cross(p_start, p_end)`, angle = `acos(dot(p_start, p_end))`.
- **Scroll wheel** → zoom (move camera along view axis).
- No clipping should occur as long as the camera stays outside the bounding sphere.

Reference: http://courses.cms.caltech.edu/cs171/assignments/hw3/hw3-notes/notes-hw3.html

```ts
export class ArcballCamera {
  getViewMatrix(objectRotation: Float32Array): Float32Array
  getCamPos(objectRotation: Float32Array): [number, number, number]
  getObjectRotationMatrix(): Float32Array
  onMouseDown(x: number, y: number): void
  onMouseMove(x: number, y: number): void
  onMouseUp(): void
  onWheel(delta: number): void
  fitCamera(center: [number,number,number], radius: number): void
}
```

---

### Task 5 — Barycentric Coordinate Rasterization (5%)

**File:** `src/main.ts` (vertex buffer fill) + `src/shader.wgsl`

Each vertex of a triangle must receive a unique barycentric coordinate:
- Vertex 0 → `[1, 0, 0]`
- Vertex 1 → `[0, 1, 0]`
- Vertex 2 → `[0, 0, 1]`

Store these in the `barycentric.xyz` slot of the interleaved vertex buffer (already in the stride). The shader's **wireframe mode** (`render_mode == 3`) already uses `min(bary.x, bary.y, bary.z)` to draw edges — make sure the values are populated correctly.

---

### Task 6 — Normal Buffer (10%)

**File:** `src/shader.wgsl`

`render_mode == 2` must output world-space normals as RGB:

```wgsl
// Normal buffer: remap [-1,1] → [0,1]
let n = normalize(in.worldNormal);
return vec4f(n * 0.5 + 0.5, 1.0);
```

The `worldNormal` interpolant is already passed from the vertex shader via `normalMat * vertex.normal`. Verify the normal matrix (`transpose(inverse(model))`) is uploaded correctly in `main.ts`.

---

### Task 7 — Gouraud & Phong Shading (10%)

**File:** `src/shader.wgsl`

Both modes use one directional/point light placed **above the camera** (e.g., `lightPos = camPos + [0, 5, 0]`).

- **Gouraud (`render_mode == 0`)**: compute `phongLight()` in the **vertex shader**; store result in `gouraudColor`; output it directly in the fragment shader.
- **Phong (`render_mode == 1`)**: compute `phongLight()` in the **fragment shader** using the interpolated `worldNormal` and `worldPos`.

`phongLight` signature (already in the shader):
```wgsl
fn phongLight(N: vec3f, worldPos: vec3f, baseColor: vec3f) -> vec3f
```

Ensure `ambient`, `diffuse`, `specular`, `shininess`, `lightPos`, `lightColor`, and `camPos` are all uploaded from `main.ts` each frame.

---

### Task 8 — Zoom & Triangle Clipping (5%)

**File:** `src/camera.ts`

- **Zoom**: scroll wheel moves the camera along the forward axis. Clamp minimum distance to `radius * 1.05` so the camera cannot enter the object.
- **Clipping**: rely on the perspective frustum (near/far planes already set). Ensure near plane is never `<= 0`. If the camera zooms very close, tighten the near plane dynamically:

```ts
const near = Math.max(0.001, this.distance - this.radius * 1.5);
const far  = this.distance + this.radius * 10;
```

Pass the updated `near`/`far` to `mat4.perspective(...)` each frame.

---

### Task 9 — Spherical Texture Mapping (15%)

**File:** `src/main.ts` (UV generation) + `src/shader.wgsl`

Compute spherical UV coordinates for every vertex:

```ts
// center = bounding sphere center of the mesh
const d = normalize(pos - center);          // direction vector
const u = 0.5 + Math.atan2(d.z, d.x) / (2 * Math.PI);
const v = 0.5 - Math.asin(d.y) / Math.PI;
```

Store `[u, v]` in the `uv.xy` slot of the interleaved vertex buffer.

In the shader, `render_mode == 5` samples the texture and multiplies by Phong shading:
```wgsl
let texColor = textureSample(tex_img, tex_samp, in.uv).rgb;
let lit = phongLight(N, in.worldPos, texColor);
return vec4f(lit, 1.0);
```

The texture upload (from the file input) and `use_texture` uniform are already wired in `main.ts`.

---

### Task 10 — Wireframe with Hidden Surface Removal (10%)

**File:** `src/shader.wgsl`

`render_mode == 3` already has access to `in.barycentric`. Implement edge detection:

```wgsl
let edge = min(in.barycentric.x, min(in.barycentric.y, in.barycentric.z));
let wire = 1.0 - smoothstep(0.0, 0.02, edge);
let color = mix(vec3f(1.0), vec3f(0.0), wire); // white fill, black edges
return vec4f(color, 1.0);
```

Hidden surface removal is handled automatically by the **depth buffer** (already configured with `depthCompare: "less"` in the pipeline). No additional work needed beyond correct barycentric values (Task 5).

---

## Uniform Upload Checklist (main.ts)

Every frame, for each `SceneObject`, call `uploadUniforms(...)` with:

| Uniform field | Source |
|---|---|
| `mvp` | `projection * view * model` |
| `model` | object's model matrix |
| `normalMat` | `transpose(inverse(model))` |
| `view` | camera view matrix |
| `lightPos` | `camPos + [0, 5, 0]` (world space) |
| `lightColor` | from GUI color picker |
| `ambient/diffuse/specular/shininess` | from object material |
| `camPos` | `camera.getCamPos(objectRotation)` |
| `render_mode` | global GUI setting |
| `objectColor` | from object material color picker |
| `use_texture` | checkbox state |
| `time` | `(now - startTime) / 1000` |
| `is_selected` | `1` if this object is selected |

---

## Vertex Buffer Interleaved Layout

```
Offset  0  : position.x   (f32)
Offset  4  : position.y   (f32)
Offset  8  : position.z   (f32)
Offset 12  : normal.x     (f32)
Offset 16  : normal.y     (f32)
Offset 20  : normal.z     (f32)
Offset 24  : barycentric.x (f32)
Offset 28  : barycentric.y (f32)
Offset 32  : barycentric.z (f32)
Offset 36  : uv.x          (f32)
Offset 40  : uv.y          (f32)
─────────────────────────────────
Stride: 44 bytes (11 × f32)
```

---

## Running the Project

```bash
npm install
npm run dev        # Vite dev server → http://localhost:5173
```

Place OBJ files in `public/models/` before running. They will be accessible at `/models/beacon.obj`, etc.

---

## Notes & Tips

- Do **not** modify `math.ts` — it is already complete and tested.
- All shader code lives in `shader.wgsl`; `main.ts` inlines it as a template string at build time.
- The `SceneObject` class wraps one WebGPU vertex buffer + uniform buffer + bind group. Keep that pattern for new mesh types.
- Use `mat4.normalMatrix(modelMatrix)` (already in `math.ts`) for the normal matrix.
- When computing arcball projections, normalize screen coordinates to `[-1, 1]` relative to the canvas center before mapping to the sphere.
- Wireframe mode relies on non-indexed draw (each triangle vertex gets its own barycentric entry). Use `drawCount = triangleCount * 3` with a flat (non-indexed) vertex buffer for wireframe, or bake the barycentric coordinates into the indexed buffer carefully.
