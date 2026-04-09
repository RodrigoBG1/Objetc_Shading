/// <reference types="@webgpu/types" />
import "./style.css";
import shaderCode from "./shader.wgsl?raw";
import { mat4 } from "./math";
import type { Vec3, Mat4 } from "./math";
import { ArcballCamera, quatToMat4 } from "./camera";

// ── WebGPU bootstrap ──────────────────────────────────────────────────────────
if (!navigator.gpu) throw new Error("WebGPU not supported");

const canvas = document.querySelector("#gfx-main") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas #gfx-main not found");

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No GPU adapter");

const device  = await adapter.requestDevice();
const context = canvas.getContext("webgpu")!;
const format  = navigator.gpu.getPreferredCanvasFormat();

let depthTexture: ReturnType<typeof device.createTexture> | null = null;

function resize() {
  canvas.width  = Math.max(1, Math.floor(window.innerWidth  * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * devicePixelRatio));
  context.configure({ device, format, alphaMode: "premultiplied" });
  depthTexture?.destroy();
  depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: 0x10, // RENDER_ATTACHMENT
  });
}
resize();
window.addEventListener("resize", resize);

// ── Uniform buffer layout ─────────────────────────────────────────────────────
// Float32 index → field mapping:
//   0–15   mvp       mat4
//  16–31   model     mat4
//  32–47   normalMat mat4
//  48–63   view      mat4
//  64–66   lightPos  vec3   67 = pad
//  68–70   lightColor vec3  71 = pad
//  72      ambient   73 diffuse  74 specular  75 shininess
//  76–78   camPos    vec3
//  79      render_mode (u32)
//  80–82   objectColor vec3
//  83      use_texture (u32)
//  84      time
//  85      is_selected (u32)
//  86–87   pad
// Total: 88 × 4 = 352 bytes
const UNIFORM_SIZE = 352;

// ── Pipeline ─────────────────────────────────────────────────────────────────
const shader = device.createShaderModule({ label: "pipeline", code: shaderCode });

const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: 3, buffer: { type: "uniform" } },   // VERTEX | FRAGMENT
    { binding: 1, visibility: 2, sampler: { type: "filtering" } }, // FRAGMENT
    { binding: 2, visibility: 2, texture: { sampleType: "float" } }, // FRAGMENT
  ],
});

const pipeline = device.createRenderPipeline({
  layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
  vertex: {
    module: shader,
    entryPoint: "vs_main",
    buffers: [{
      arrayStride: 44, // 11 floats × 4 bytes
      attributes: [
        { shaderLocation: 0, offset:  0, format: "float32x3" }, // position
        { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
        { shaderLocation: 2, offset: 24, format: "float32x3" }, // barycentric
        { shaderLocation: 3, offset: 36, format: "float32x2" }, // uv
      ],
    }],
  },
  fragment: { module: shader, entryPoint: "fs_main", targets: [{ format }] },
  primitive: { topology: "triangle-list", cullMode: "back" },
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
});

const defaultSampler = device.createSampler({
  magFilter: "linear", minFilter: "linear",
  addressModeU: "repeat", addressModeV: "repeat",
});

// ── Default 1×1 white texture ─────────────────────────────────────────────────
function makeWhiteTexture() {
  const tex = device.createTexture({
    size: [1, 1], format: "rgba8unorm",
    usage: 0x04 | 0x02, // TEXTURE_BINDING | COPY_DST
  });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  return tex;
}

// ── Vertex data helpers ───────────────────────────────────────────────────────

/**
 * Expand an indexed vertex buffer (8 floats/vtx: pos3+norm3+uv2) into a flat
 * non-indexed buffer (11 floats/vtx: pos3+norm3+bary3+uv2) with barycentric
 * coordinates assigned per-triangle-vertex so the wireframe mode works.
 */
function expandToFlat(vd: Float32Array, id: Uint32Array): Float32Array {
  const triCount = id.length / 3;
  const out = new Float32Array(triCount * 3 * 11);
  const bary = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const vi = id[t * 3 + c];
      const s  = (t * 3 + c) * 11;
      // pos
      out[s]   = vd[vi * 8];     out[s+1] = vd[vi * 8 + 1]; out[s+2] = vd[vi * 8 + 2];
      // normal
      out[s+3] = vd[vi * 8 + 3]; out[s+4] = vd[vi * 8 + 4]; out[s+5] = vd[vi * 8 + 5];
      // barycentric
      out[s+6] = bary[c][0]; out[s+7] = bary[c][1]; out[s+8] = bary[c][2];
      // uv
      out[s+9] = vd[vi * 8 + 6]; out[s+10] = vd[vi * 8 + 7];
    }
  }
  return out;
}

function uploadVertexBuffer(flat: Float32Array) {
  const buf = device.createBuffer({
    size: flat.byteLength,
    usage: 0x20 | 0x08, // VERTEX | COPY_DST
  });
  device.queue.writeBuffer(buf, 0, flat.buffer);
  return buf;
}

// ── Geometry generators ───────────────────────────────────────────────────────

/** UV sphere: returns indexed vertex data (8 floats/vtx). */
function generateSphere(stacks: number, slices: number): { vd: Float32Array; id: Uint32Array } {
  const verts: number[] = [];
  for (let i = 0; i <= stacks; i++) {
    const phi    = Math.PI * i / stacks;
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    for (let j = 0; j <= slices; j++) {
      const theta = 2 * Math.PI * j / slices;
      const x = sinPhi * Math.cos(theta);
      const y = cosPhi;
      const z = sinPhi * Math.sin(theta);
      // pos=normal for unit sphere; uv = (j/slices, i/stacks)
      verts.push(x, y, z,  x, y, z,  j / slices, i / stacks);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * (slices + 1) + j;
      const b = a + 1;
      const c = a + (slices + 1);
      const d = c + 1;
      indices.push(a, c, b,  b, c, d);
    }
  }
  return { vd: new Float32Array(verts), id: new Uint32Array(indices) };
}

/** Axis-aligned cube: returns indexed vertex data (8 floats/vtx). */
function generateCube(): { vd: Float32Array; id: Uint32Array } {
  const faces: Array<{ n: Vec3; v: number[][] }> = [
    { n: [ 0,  0,  1], v: [[-1,-1, 1, 0,1],[1,-1, 1,1,1],[1, 1, 1,1,0],[-1, 1, 1,0,0]] },
    { n: [ 0,  0, -1], v: [[ 1,-1,-1, 0,1],[-1,-1,-1,1,1],[-1, 1,-1,1,0],[1, 1,-1,0,0]] },
    { n: [-1,  0,  0], v: [[-1,-1,-1, 0,1],[-1,-1, 1,1,1],[-1, 1, 1,1,0],[-1, 1,-1,0,0]] },
    { n: [ 1,  0,  0], v: [[ 1,-1, 1, 0,1],[ 1,-1,-1,1,1],[ 1, 1,-1,1,0],[ 1, 1, 1,0,0]] },
    { n: [ 0,  1,  0], v: [[-1, 1, 1, 0,1],[ 1, 1, 1,1,1],[ 1, 1,-1,1,0],[-1, 1,-1,0,0]] },
    { n: [ 0, -1,  0], v: [[-1,-1,-1, 0,1],[ 1,-1,-1,1,1],[ 1,-1, 1,1,0],[-1,-1, 1,0,0]] },
  ];
  const verts: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const face of faces) {
    for (const v of face.v) verts.push(v[0], v[1], v[2], ...face.n, v[3], v[4]);
    indices.push(base, base+1, base+2,  base, base+2, base+3);
    base += 4;
  }
  return { vd: new Float32Array(verts), id: new Uint32Array(indices) };
}

// ── OBJ parser ────────────────────────────────────────────────────────────────

interface ParsedMesh {
  positions:     Float32Array; // vertexCount × 3
  normals:       Float32Array; // vertexCount × 3 (averaged face normals)
  uvs:           Float32Array; // vertexCount × 2
  indices:       Uint32Array;  // triangleCount × 3
  vertexCount:   number;
  triangleCount: number;
}

function vec3sub(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}
function vec3cross(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function vec3normalize(v: [number,number,number]): [number,number,number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/len, v[1]/len, v[2]/len];
}

/**
 * Parse an OBJ text file into a mesh suitable for uploading to WebGPU.
 *
 * Task 1 — OBJ parsing: v, vt, f lines; fan-triangulation of polygons.
 * Task 3 — Normals: compute per-face normals, average to per-vertex normals.
 * Task 9 — UVs: use OBJ vt data when present; otherwise compute spherical UVs.
 */
function parseOBJ(text: string): ParsedMesh {
  const positions: [number,number,number][] = [];
  const texCoords: [number,number][]         = [];
  const triangles: [[number,number|null],[number,number|null],[number,number|null]][] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tok = line.split(/\s+/);
    if (tok[0] === "v") {
      positions.push([parseFloat(tok[1]), parseFloat(tok[2]), parseFloat(tok[3])]);
    } else if (tok[0] === "vt") {
      texCoords.push([parseFloat(tok[1]), parseFloat(tok[2])]);
    } else if (tok[0] === "f") {
      // Each token is posIdx[/uvIdx[/normIdx]] (1-based)
      const verts = tok.slice(1).map(t => {
        const s = t.split("/");
        const pi = parseInt(s[0]) - 1;
        const ui = s[1] && s[1] !== "" ? parseInt(s[1]) - 1 : null;
        return [pi, ui] as [number, number | null];
      });
      // Fan-triangulate polygons
      for (let i = 1; i + 1 < verts.length; i++) {
        triangles.push([verts[0], verts[i], verts[i + 1]]);
      }
    }
  }

  const vc = positions.length;
  const tc = triangles.length;
  const hasUV = texCoords.length > 0;

  const posArr  = new Float32Array(vc * 3);
  const normArr = new Float32Array(vc * 3); // accumulate, then normalize
  const uvArr   = new Float32Array(vc * 2);
  const idxArr  = new Uint32Array(tc * 3);

  // Fill positions
  for (let i = 0; i < vc; i++) {
    posArr[i*3]   = positions[i][0];
    posArr[i*3+1] = positions[i][1];
    posArr[i*3+2] = positions[i][2];
  }

  // Per-face normals → accumulate into vertex normals; fill indices & OBJ UVs
  for (let t = 0; t < tc; t++) {
    const [[i0,u0],[i1,u1],[i2,u2]] = triangles[t];
    const faceNorm = vec3normalize(vec3cross(
      vec3sub(positions[i1], positions[i0]),
      vec3sub(positions[i2], positions[i0]),
    ));
    // Accumulate face normal into each vertex normal
    for (const vi of [i0, i1, i2]) {
      normArr[vi*3]   += faceNorm[0];
      normArr[vi*3+1] += faceNorm[1];
      normArr[vi*3+2] += faceNorm[2];
    }
    idxArr[t*3]   = i0;
    idxArr[t*3+1] = i1;
    idxArr[t*3+2] = i2;
    // Assign OBJ texture coordinates (first occurrence wins per vertex)
    if (hasUV) {
      for (const [vi, ui] of [[i0,u0],[i1,u1],[i2,u2]] as [number, number|null][]) {
        if (ui !== null && uvArr[vi*2] === 0 && uvArr[vi*2+1] === 0) {
          uvArr[vi*2]   = texCoords[ui][0];
          uvArr[vi*2+1] = 1 - texCoords[ui][1]; // flip V for WebGPU
        }
      }
    }
  }

  // Normalize accumulated vertex normals
  for (let i = 0; i < vc; i++) {
    const len = Math.hypot(normArr[i*3], normArr[i*3+1], normArr[i*3+2]) || 1;
    normArr[i*3]   /= len;
    normArr[i*3+1] /= len;
    normArr[i*3+2] /= len;
  }

  // Task 9 — Spherical UV mapping when no OBJ texture coordinates are present
  if (!hasUV) {
    for (let i = 0; i < vc; i++) {
      const nx = normArr[i*3], ny = normArr[i*3+1], nz = normArr[i*3+2];
      uvArr[i*2]   = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
      uvArr[i*2+1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    }
  }

  return { positions: posArr, normals: normArr, uvs: uvArr, indices: idxArr, vertexCount: vc, triangleCount: tc };
}

/** Interleave positions, normals and UVs into an 8-float-per-vertex array. */
function buildVertexData(mesh: ParsedMesh): { vd: Float32Array; id: Uint32Array } {
  const vd = new Float32Array(mesh.vertexCount * 8);
  for (let i = 0; i < mesh.vertexCount; i++) {
    vd[i*8]   = mesh.positions[i*3];   vd[i*8+1] = mesh.positions[i*3+1]; vd[i*8+2] = mesh.positions[i*3+2];
    vd[i*8+3] = mesh.normals[i*3];     vd[i*8+4] = mesh.normals[i*3+1];   vd[i*8+5] = mesh.normals[i*3+2];
    vd[i*8+6] = mesh.uvs[i*2];         vd[i*8+7] = mesh.uvs[i*2+1];
  }
  return { vd, id: mesh.indices };
}

/** Compute bounding-sphere center and radius from vertex positions. */
function boundingSphere(mesh: ParsedMesh): { center: Vec3; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i*3], y = mesh.positions[i*3+1], z = mesh.positions[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX+maxX)/2, cy = (minY+maxY)/2, cz = (minZ+maxZ)/2;
  let radius = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const dx = mesh.positions[i*3]-cx, dy = mesh.positions[i*3+1]-cy, dz = mesh.positions[i*3+2]-cz;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d > radius) radius = d;
  }
  return { center: [cx, cy, cz], radius };
}

// ── SceneObject ───────────────────────────────────────────────────────────────

interface Transform { tx:number; ty:number; tz:number; rx:number; ry:number; rz:number; sx:number; sy:number; sz:number; }
interface Material  { ambient:number; diffuse:number; specular:number; shininess:number; color:string; }

function defaultTransform(): Transform { return { tx:0,ty:0,tz:0, rx:0,ry:0,rz:0, sx:1,sy:1,sz:1 }; }
function defaultMaterial():  Material  { return { ambient:0.12, diffuse:0.75, specular:0.55, shininess:48, color:"#4a9eff" }; }

let nextId = 0;

class SceneObject {
  readonly id = nextId++;
  label: string;
  vertexBuffer: ReturnType<typeof device.createBuffer>;
  drawCount: number;
  uniformBuf:  ReturnType<typeof device.createBuffer>;
  texture:     ReturnType<typeof device.createTexture>;
  bindGroup:   ReturnType<typeof device.createBindGroup>;
  useTexture = 0;
  transform: Transform;
  material:  Material;
  savedRotation: [number,number,number,number] = [0,0,0,1];

  private _uab = new ArrayBuffer(UNIFORM_SIZE);
  private _uf32 = new Float32Array(this._uab);
  private _uu32 = new Uint32Array(this._uab);

  constructor(label: string, vertexBuffer: ReturnType<typeof device.createBuffer>, drawCount: number) {
    this.label        = label;
    this.vertexBuffer = vertexBuffer;
    this.drawCount    = drawCount;
    this.transform    = defaultTransform();
    this.material     = defaultMaterial();
    this.texture      = makeWhiteTexture();
    this.uniformBuf   = device.createBuffer({ size: UNIFORM_SIZE, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
    this.bindGroup    = this._makeBindGroup();
  }

  worldPos(): Vec3 { return [this.transform.tx, this.transform.ty, this.transform.tz]; }

  setTexture(tex: ReturnType<typeof device.createTexture>): void {
    this.texture.destroy();
    this.texture    = tex;
    this.useTexture = 1;
    this.bindGroup  = this._makeBindGroup();
  }

  buildModel(arcballRot: Mat4): Mat4 {
    const { tx,ty,tz, rx,ry,rz, sx,sy,sz } = this.transform;
    const T = mat4.translation(tx, ty, tz);
    const S = mat4.scaling(sx, sy, sz);
    const R = mat4.multiply(mat4.rotationZ(rz), mat4.multiply(mat4.rotationY(ry), mat4.multiply(mat4.rotationX(rx), arcballRot)));
    return mat4.multiply(T, mat4.multiply(R, S));
  }

  uploadUniforms(
    arcballRot: Mat4,
    view:       Mat4,
    proj:       Mat4,
    lightPos:   Vec3,
    lightColor: Vec3,
    camPos:     Vec3,
    renderMode: number,
    time:       number,
    isSelected: boolean,
  ): void {
    const model    = this.buildModel(arcballRot);
    const normalM  = mat4.normalMatrix(model);
    const mvp      = mat4.multiply(proj, mat4.multiply(view, model));
    const [lr,lg,lb] = lightColor;
    const mat      = this.material;
    const [or,og,ob] = hexToRgb(mat.color);
    const f = this._uf32, u = this._uu32;

    f.set(mvp,    0);
    f.set(model, 16);
    f.set(normalM,32);
    f.set(view,  48);
    f[64] = lightPos[0]; f[65] = lightPos[1]; f[66] = lightPos[2]; f[67] = 0;
    f[68] = lr;          f[69] = lg;          f[70] = lb;          f[71] = 0;
    f[72] = mat.ambient; f[73] = mat.diffuse;  f[74] = mat.specular; f[75] = mat.shininess;
    f[76] = camPos[0];   f[77] = camPos[1];    f[78] = camPos[2];
    u[79] = renderMode;
    f[80] = or;          f[81] = og;           f[82] = ob;
    u[83] = this.useTexture;
    f[84] = time;
    u[85] = isSelected ? 1 : 0;

    device.queue.writeBuffer(this.uniformBuf, 0, this._uab);
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.uniformBuf.destroy();
    this.texture.destroy();
  }

  private _makeBindGroup() {
    return device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: defaultSampler },
        { binding: 2, resource: this.texture.createView() },
      ],
    });
  }
}

// ── Helpers to build SceneObjects ─────────────────────────────────────────────

function makeObject(label: string, vd: Float32Array, id: Uint32Array): SceneObject {
  return new SceneObject(label, uploadVertexBuffer(expandToFlat(vd, id)), id.length);
}

async function loadOBJ(name: string, text: string): Promise<SceneObject> {
  const mesh  = parseOBJ(text);
  const { vd, id } = buildVertexData(mesh);
  const obj   = makeObject(name, vd, id);
  const bs    = boundingSphere(mesh);
  // Center the model at the origin by setting translation to -center
  obj.transform.tx = -bs.center[0];
  obj.transform.ty = -bs.center[1];
  obj.transform.tz = -bs.center[2];
  camera.fitCamera(bs.center, bs.radius);
  return obj;
}

// ── Scene state ───────────────────────────────────────────────────────────────
const objects: SceneObject[] = [];
let selectedIndex = -1;
const camera = new ArcballCamera(canvas);
camera.objectSelected = false;

const LIGHT_POS: Vec3 = [3, 6, 7];

function sceneTarget(): Vec3 {
  return selectedIndex >= 0 && objects[selectedIndex]
    ? objects[selectedIndex].worldPos()
    : [0, 0, 0];
}

function select(idx: number): void {
  if (selectedIndex >= 0 && objects[selectedIndex]) {
    objects[selectedIndex].savedRotation = camera.saveRotation();
  }
  selectedIndex = idx;
  if (idx >= 0 && objects[idx]) {
    camera.objectSelected = true;
    camera.loadRotation(objects[idx].savedRotation);
  } else {
    camera.objectSelected = false;
  }
  refreshObjectList();
  refreshInspector();
}

function addObject(obj: SceneObject): void {
  objects.push(obj);
  select(objects.length - 1);
}

function removeSelected(): void {
  if (selectedIndex < 0 || objects.length === 0) return;
  objects[selectedIndex].savedRotation = camera.saveRotation();
  objects[selectedIndex].destroy();
  objects.splice(selectedIndex, 1);
  select(objects.length === 0 ? -1 : Math.max(0, selectedIndex - 1));
}

// ── GUI ───────────────────────────────────────────────────────────────────────

const globalGui = { renderMode: 1, lightColor: "#ffffff" };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function slider(id: string, label: string, min: number, max: number, step: number, val: number): string {
  const disp = Number.isInteger(val) ? String(val) : val.toFixed(2);
  return `<div class="slider-row">
    <span class="slider-label">${label}</span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
    <span class="slider-val" id="${id}-val">${disp}</span></div>`;
}

const MODE_DESCS: Record<number, string> = {
  0: "Gouraud: lighting per vertex, colour interpolated across face.",
  1: "Phong: normals interpolated per fragment, lighting per pixel.",
  2: "Normal buffer: world-space normals encoded as RGB (R=X  G=Y  B=Z).",
  3: "Wireframe: black edges on white. Hidden surfaces removed by z-buffer.",
  4: "Depth: linear depth as greyscale -- directly shows z-buffer values.",
  5: "Texture: spherical-mapped image multiplied by Phong shading.",
  6: "UV coords: U -> Red,  V -> Green.  Black=(0,0)  Yellow=(1,1).",
};

const guiRoot = document.createElement("div");
guiRoot.id = "gui";
guiRoot.innerHTML = `
<div class="gui-panel" id="panel-left">
  <div class="gui-title">Pipeline</div>
  <div class="gui-section">
    <div class="gui-label">Add Object</div>
    <div class="btn-row">
      <button id="add-sphere">Sphere</button>
      <button id="add-cube">Cube</button>
    </div>
    <div class="gui-label" style="margin-top:6px">Add OBJ Model</div>
    <input type="file" id="obj-upload" accept=".obj" class="file-input">
  </div>
  <div class="gui-section">
    <div class="gui-label">Render Mode (global)</div>
    <div class="btn-row">
      <button class="mode-btn" data-id="0">Gouraud</button>
      <button class="mode-btn active" data-id="1">Phong</button>
      <button class="mode-btn" data-id="2">Normals</button>
    </div>
    <div class="btn-row">
      <button class="mode-btn" data-id="3">Wireframe</button>
      <button class="mode-btn" data-id="4">Depth</button>
      <button class="mode-btn" data-id="5">Texture</button>
      <button class="mode-btn" data-id="6">UV Coords</button>
    </div>
    <div class="mode-desc" id="mode-desc"></div>
  </div>
  <div class="gui-section">
    <div class="gui-label">Global Light Color</div>
    <div class="color-row">
      <span>Light</span><input type="color" id="g-lightColor" value="#ffffff">
    </div>
  </div>
  <div class="gui-hint">No selection: drag orbits camera<br>Object selected: drag rotates object<br>Scroll: zoom</div>
</div>

<div class="gui-panel" id="panel-right">
  <div class="gui-title">Scene</div>
  <div id="object-list"></div>
  <div class="btn-row" style="margin-top:6px">
    <button id="btn-deselect">Deselect</button>
    <button id="btn-remove">Remove</button>
  </div>
  <div id="inspector" style="margin-top:10px">
    <div class="inspector-label" id="inspector-title">No selection — camera orbit mode</div>
    <div class="gui-label">Transform</div>
    ${slider("tr-tx","Translate X",-12,12,.05,0)}
    ${slider("tr-ty","Translate Y",-12,12,.05,0)}
    ${slider("tr-tz","Translate Z",-12,12,.05,0)}
    ${slider("tr-rx","Rotate X",-3.15,3.15,.01,0)}
    ${slider("tr-ry","Rotate Y",-3.15,3.15,.01,0)}
    ${slider("tr-rz","Rotate Z",-3.15,3.15,.01,0)}
    ${slider("tr-sx","Scale X",.05,6,.05,1)}
    ${slider("tr-sy","Scale Y",.05,6,.05,1)}
    ${slider("tr-sz","Scale Z",.05,6,.05,1)}
    <div class="gui-label">Material</div>
    ${slider("mt-ambient","Ambient (Ka)",0,1,.01,.12)}
    ${slider("mt-diffuse","Diffuse (Kd)",0,1,.01,.75)}
    ${slider("mt-specular","Specular (Ks)",0,1,.01,.55)}
    ${slider("mt-shine","Shininess (n)",1,256,1,48)}
    <div class="color-row" style="margin-top:4px">
      <span>Object color</span><input type="color" id="mt-color" value="#4a9eff">
    </div>
    <div class="gui-label">Texture (spherical UV)</div>
    <input type="file" id="tex-upload" accept="image/*" class="file-input">
    <label class="checkbox-row"><input type="checkbox" id="use-texture"> Use texture</label>
  </div>
</div>`;
document.body.appendChild(guiRoot);

// Mode description
function refreshModeDesc(): void {
  document.getElementById("mode-desc")!.textContent = MODE_DESCS[globalGui.renderMode];
}
refreshModeDesc();

// Render mode buttons
document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    globalGui.renderMode = Number(btn.dataset.id);
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    refreshModeDesc();
  });
});

// Add sphere / cube
document.getElementById("add-sphere")!.addEventListener("click", () => {
  const { vd, id } = generateSphere(64, 64);
  addObject(makeObject("Sphere", vd, id));
});
document.getElementById("add-cube")!.addEventListener("click", () => {
  const { vd, id } = generateCube();
  addObject(makeObject("Cube", vd, id));
});

// OBJ upload
document.getElementById("obj-upload")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  addObject(await loadOBJ(file.name.replace(".obj", ""), await file.text()));
});

// Deselect / remove
document.getElementById("btn-deselect")!.addEventListener("click", () => select(-1));
document.getElementById("btn-remove")!.addEventListener("click", removeSelected);

// Global light color
document.getElementById("g-lightColor")!.addEventListener("input", (e) => {
  globalGui.lightColor = (e.target as HTMLInputElement).value;
});

// Object list
function refreshObjectList(): void {
  const list = document.getElementById("object-list")!;
  list.innerHTML = "";
  objects.forEach((obj, i) => {
    const btn = document.createElement("button");
    btn.className = "obj-list-btn" + (i === selectedIndex ? " active" : "");
    btn.textContent = `${i + 1}. ${obj.label}`;
    btn.addEventListener("click", () => select(i === selectedIndex ? -1 : i));
    list.appendChild(btn);
  });
}

// Inspector helpers
function setSlider(id: string, val: number): void {
  const el  = document.getElementById(id) as HTMLInputElement | null;
  const vEl = document.getElementById(`${id}-val`);
  if (el)  el.value = String(val);
  if (vEl) vEl.textContent = Number.isInteger(val) ? String(val) : val.toFixed(2);
}

function refreshInspector(): void {
  const title = document.getElementById("inspector-title")!;
  if (selectedIndex < 0 || !objects[selectedIndex]) {
    title.textContent = "No selection — camera orbit mode";
    return;
  }
  const obj = objects[selectedIndex];
  title.textContent = obj.label;
  const t = obj.transform;
  setSlider("tr-tx", t.tx); setSlider("tr-ty", t.ty); setSlider("tr-tz", t.tz);
  setSlider("tr-rx", t.rx); setSlider("tr-ry", t.ry); setSlider("tr-rz", t.rz);
  setSlider("tr-sx", t.sx); setSlider("tr-sy", t.sy); setSlider("tr-sz", t.sz);
  const m = obj.material;
  setSlider("mt-ambient", m.ambient); setSlider("mt-diffuse", m.diffuse);
  setSlider("mt-specular", m.specular); setSlider("mt-shine", m.shininess);
  (document.getElementById("mt-color") as HTMLInputElement).value = m.color;
  (document.getElementById("use-texture") as HTMLInputElement).checked = obj.useTexture === 1;
}

// Transform sliders
function bindSlider(id: string, apply: (obj: SceneObject, v: number) => void): void {
  const el  = document.getElementById(id) as HTMLInputElement;
  const vEl = document.getElementById(`${id}-val`);
  if (!el) return;
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    if (vEl) vEl.textContent = Number.isInteger(v) ? String(v) : v.toFixed(2);
    if (selectedIndex >= 0 && objects[selectedIndex]) apply(objects[selectedIndex], v);
  });
}

bindSlider("tr-tx", (o,v) => { o.transform.tx = v; });
bindSlider("tr-ty", (o,v) => { o.transform.ty = v; });
bindSlider("tr-tz", (o,v) => { o.transform.tz = v; });
bindSlider("tr-rx", (o,v) => { o.transform.rx = v; });
bindSlider("tr-ry", (o,v) => { o.transform.ry = v; });
bindSlider("tr-rz", (o,v) => { o.transform.rz = v; });
bindSlider("tr-sx", (o,v) => { o.transform.sx = v; });
bindSlider("tr-sy", (o,v) => { o.transform.sy = v; });
bindSlider("tr-sz", (o,v) => { o.transform.sz = v; });
bindSlider("mt-ambient",  (o,v) => { o.material.ambient   = v; });
bindSlider("mt-diffuse",  (o,v) => { o.material.diffuse   = v; });
bindSlider("mt-specular", (o,v) => { o.material.specular  = v; });
bindSlider("mt-shine",    (o,v) => { o.material.shininess = v; });

(document.getElementById("mt-color") as HTMLInputElement).addEventListener("input", (e) => {
  if (selectedIndex >= 0 && objects[selectedIndex])
    objects[selectedIndex].material.color = (e.target as HTMLInputElement).value;
});

// Texture upload
document.getElementById("tex-upload")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || selectedIndex < 0 || !objects[selectedIndex]) return;
  const bmp = await createImageBitmap(file, { colorSpaceConversion: "none" });
  const tex = device.createTexture({
    size: [bmp.width, bmp.height], format: "rgba8unorm",
    usage: 0x04 | 0x02 | 0x10, // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT
  });
  device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
  objects[selectedIndex].setTexture(tex);
  (document.getElementById("use-texture") as HTMLInputElement).checked = true;
});

(document.getElementById("use-texture") as HTMLInputElement).addEventListener("change", (e) => {
  if (selectedIndex >= 0 && objects[selectedIndex])
    objects[selectedIndex].useTexture = (e.target as HTMLInputElement).checked ? 1 : 0;
});

// ── Seed the scene with a sphere and a cube ───────────────────────────────────
{
  const { vd, id } = generateSphere(64, 64);
  const s = makeObject("Sphere", vd, id);
  s.transform.tx = -2.5;
  objects.push(s);
}
{
  const { vd, id } = generateCube();
  const c = makeObject("Cube", vd, id);
  c.transform.tx = 2.5;
  objects.push(c);
}
selectedIndex = -1;
camera.objectSelected = false;
refreshObjectList();
refreshInspector();

// ── Render loop ───────────────────────────────────────────────────────────────
const startTime = performance.now();

function frame(now: number): void {
  const t      = (now - startTime) / 1000;
  const aspect = canvas.width / canvas.height;
  const [near, far] = camera.getNearFar();
  const proj   = mat4.perspective((60 * Math.PI) / 180, aspect, near, far);

  const [lr, lg, lb] = hexToRgb(globalGui.lightColor);
  const lightColor: Vec3 = [lr, lg, lb];

  const target = sceneTarget();
  const view   = camera.getViewMatrix(target);
  const camPos = camera.getCamPos(target);

  const identityRot = quatToMat4([0, 0, 0, 1]);
  const objectRot   = selectedIndex >= 0 && objects[selectedIndex]
    ? camera.getObjectRotationMatrix()
    : identityRot;

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0.08, g: 0.08, b: 0.12, a: 1 },
      loadOp: "clear", storeOp: "store",
    }],
    depthStencilAttachment: {
      view: depthTexture!.createView(),
      depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
    },
  });

  pass.setPipeline(pipeline);

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const isSelected = i === selectedIndex;
    const rot = isSelected ? objectRot : quatToMat4(obj.savedRotation);
    obj.uploadUniforms(rot, view, proj, LIGHT_POS, lightColor, camPos, globalGui.renderMode, t, isSelected);
    pass.setBindGroup(0, obj.bindGroup);
    pass.setVertexBuffer(0, obj.vertexBuffer);
    pass.draw(obj.drawCount);
  }

  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
