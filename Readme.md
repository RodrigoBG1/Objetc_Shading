# Lighting Models — WebGPU

WebGPU assignment where you implement real-time lighting models from scratch: **Gouraud**, **Phong**, and **Blinn-Phong** shading, plus generate a **UV sphere** geometry.

---

## Getting Started

```bash
npm install
npm run dev
```

Then open your browser at the URL shown in the terminal (`http://localhost:5173`).

---

## Project Structure

```
src/
├── main.ts        ← TASK A: implement generateSphere()
├── shader.wgsl    ← TASK B: implement the three lighting functions
├── camera.ts      ← provided, no changes needed
├── math.ts        ← provided, no changes needed
└── style.css      ← provided, no changes needed
```

---

## Your Tasks

### Task A — Sphere Geometry

The **cube** is already implemented as a reference. 
Your task is to fill in `generateSphere(stacks, slices)`.

A UV sphere is built from a latitude/longitude grid. For each vertex at ring `i` and column `j`:

```
phi   = PI  * i / stacks     // latitude:  0 (top) → PI (bottom)
theta = 2PI * j / slices     // longitude: 0 → 2PI around Y axis

x = sin(phi) * cos(theta)
y = cos(phi)                 // Y is up
z = sin(phi) * sin(theta)
```

For a unit sphere the **normal equals the position**: `n = (x, y, z)`.

UV coordinates: `u = j / slices`, `v = i / stacks`.

Connect the grid into triangles (two per quad):

Each vertex in the output array must follow the format: `[x, y, z, nx, ny, nz, u, v]` — the same 8-float stride as the cube so the same GPU pipeline handles both shapes.

---

### Task B — Lighting Models

The file header reminds you of the relevant WGSL built-ins and which functions are done vs. TODO:

```wgsl
// The uniform struct and vertex pipeline are already wired up for you.
// Your tasks are marked with TODO comments below.
//
// model_id values (set by the GUI buttons):
//   0 = Flat        implemented — study this one first
//   1 = Gouraud     TODO
//   2 = Phong       TODO
//   3 = Blinn-Phong TODO
//
// Useful WGSL built-ins:
//   normalize(v)        — returns unit vector
//   dot(a, b)           — scalar dot product
//   reflect(I, N)       — reflects incident vector I around normal N
//   max(a, b)           — component-wise max
//   pow(base, exp)      — power function
//   dpdx(v), dpdy(v)    — screen-space partial derivatives (fragment stage only)
//   cross(a, b)         — cross product
```

The **Flat shading** function is fully implemented — read it carefully before writing anything else. It shows the complete ambient + diffuse + specular formula you will reuse in all three models.

All the data you need is in the uniform block `u`:

| Uniform | Type | Description |
|---|---|---|
| `u.lightPos` | `vec3` | Light position in world space |
| `u.lightColor` | `vec3` | RGB light colour |
| `u.camPos` | `vec3` | Camera position in world space |
| `u.ambient` | `f32` | Ambient coefficient Ka |
| `u.diffuse` | `f32` | Diffuse coefficient Kd |
| `u.specular` | `f32` | Specular coefficient Ks |
| `u.shininess` | `f32` | Specular exponent n |
| `u.objectColor` | `vec3` | Base colour of the object |

---

#### 1. Gouraud Shading 

Called **once per vertex** in `vs_main`, not per fragment. The GPU linearly interpolates the resulting colour across the triangle face.

Gouraud lighting is identical in formula to Phong, but evaluated at vertices:
1. Use the smooth interpolated vertex normal `N` passed in as a parameter.
2. Compute ambient + diffuse + specular exactly as in `flatShading()`, but replace `faceN` with `N`.
3. Return the final `vec3` colour.

> **Why specular highlights can disappear:** The highlight peak might sit between vertices and get missed by linear interpolation — this is the key visual difference you should observe compared to Phong.

---

#### 2. Phong Shading

Called **once per fragment** in `fs_main`. Normals are interpolated per pixel so the highlight is computed at every pixel.

1. Compute `L` and `V` from `fragWorldPos`
2. Use the interpolated `N` (not a face normal).
3. Specular: `R = reflect(-L, N)`, then `pow(max(dot(R, V), 0), shininess)`.
4. Return `(ambientC + diffuseC + specularC) * u.objectColor`.

> **Key difference vs Gouraud:** Because lighting runs per pixel, highlights are always sharp and correctly placed regardless of polygon count.

---

#### 3. Blinn-Phong Shading

Called **once per fragment** in `fs_main`. Everything else (ambient, diffuse) is identical to Phong — only the specular term changes.

1. Compute `L` and `V` from `fragWorldPos`.
2. Compute the **half-vector**: `H = normalize(L + V)` — the bisector between light and view directions.
3. Specular: `pow(max(dot(N, H), 0), shininess)` — replace `reflect()` with `dot(N, H)`.
4. Return `(ambientC + diffuseC + specularC) * u.objectColor`.

---

## Lighting Equation Reference

All four models share the same base equation — only *where* it runs and *which normal* is used differs:

```
ambient  = Ka * lightColor
diffuse  = Kd * max(dot(N, L), 0) * lightColor
specular = Ks * pow(spec_term, n) * lightColor

final = (ambient + diffuse + specular) * objectColor
```

| Model | Normal source | Specular term | Stage |
|---|---|---|---|
| Flat | `cross(dpdx(pos), dpdy(pos))` | `dot(R, V)` | Fragment |
| Gouraud | per-vertex normal | `dot(R, V)` | **Vertex** |
| Phong | interpolated per-pixel normal | `dot(R, V)` | Fragment |
| Blinn-Phong | interpolated per-pixel normal | `dot(N, H)` | Fragment |

---

## Controls

| Key | Action |
|---|---|
| `W A S D` | Move camera forward / left / back / right |
| `Q E` | Move camera down / up |
| `Arrow keys` | Rotate camera look direction |
| GUI buttons | Switch shading model and geometry |
| GUI sliders | Adjust Ka, Kd, Ks, shininess, light position |

---

## Hints

- The Sphere button shows nothing until `generateSphere()` returns real geometry — a `console.warn` will appear in DevTools.
- Read the fully implemented `flatShading()` function line by line before writing anything else — all three models reuse the same structure.
- The normal matrix is already applied in `vs_main` before normals reach your functions — you receive a correctly transformed world-space normal.
