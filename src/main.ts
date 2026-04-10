/// <reference types="@webgpu/types" />
import "./style.css";
import shaderCode from "./shader.wgsl?raw";
import { mat4 } from "./math";
import type { Vec3, Mat4 } from "./math";
import { ArcballCamera, quatToMat4 } from "./camera";

/* WebGPU initialization */

if (!navigator.gpu) throw new Error("WebGPU not supported in this browser");

const canvas = document.querySelector("#gfx-main") as HTMLCanvasElement;
if (!canvas) throw new Error("Could not find canvas #gfx-main");

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No suitable GPU adapter found");

const device  = await adapter.requestDevice();
const ctx     = canvas.getContext("webgpu")!;
const swapFmt = navigator.gpu.getPreferredCanvasFormat();

let depthTex: ReturnType<typeof device.createTexture> | null = null;

function onResize() {
  canvas.width  = Math.max(1, Math.floor(window.innerWidth  * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * devicePixelRatio));
  ctx.configure({ device, format: swapFmt, alphaMode: "premultiplied" });
  depthTex?.destroy();
  depthTex = device.createTexture({
    size:   [canvas.width, canvas.height],
    format: "depth24plus",
    usage:  GPUTextureUsage.RENDER_ATTACHMENT,
  });
}
onResize();
window.addEventListener("resize", onResize);


const UBO_BYTES = 352;


const shaderMod = device.createShaderModule({ label: "main-shader", code: shaderCode });

const bgl = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  ],
});

const renderPipeline = device.createRenderPipeline({
  layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
  vertex: {
    module:     shaderMod,
    entryPoint: "vs_main",
    buffers: [{
      // 11 floats per vertex: pos(3) + norm(3) + bary(3) + uv(2)
      arrayStride: 44,
      attributes: [
        { shaderLocation: 0, offset:  0, format: "float32x3" }, // position
        { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
        { shaderLocation: 2, offset: 24, format: "float32x3" }, // barycentric
        { shaderLocation: 3, offset: 36, format: "float32x2" }, // uv
      ],
    }],
  },
  fragment: { module: shaderMod, entryPoint: "fs_main", targets: [{ format: swapFmt }] },
  primitive:    { topology: "triangle-list", cullMode: "back" },
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
});

const trilinearSampler = device.createSampler({
  magFilter: "linear", minFilter: "linear",
  addressModeU: "repeat", addressModeV: "repeat",
});

/* GPU buffer helpers */

/** 1×1 white fallback texture used when no image is loaded. */
function createBlankTexture() {
  const tex = device.createTexture({
    size: [1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  return tex;
}

/**
 * Converts an indexed vertex array (8 f32/vtx: pos+norm+uv) into a flat
 * non-indexed array (11 f32/vtx: pos+norm+bary+uv).  Each triangle corner
 * gets a unique barycentric coordinate [1,0,0], [0,1,0] or [0,0,1] so the
 * wireframe shader can detect edges via smoothstep.
 */
function buildFlatBuffer(vtx: Float32Array, idx: Uint32Array): Float32Array {
  const tris = idx.length / 3;
  const buf  = new Float32Array(tris * 3 * 11);
  const baryCoords = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

  for (let t = 0; t < tris; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const vi  = idx[t * 3 + corner];
      const dst = (t * 3 + corner) * 11;
      buf[dst]   = vtx[vi * 8];     buf[dst+1] = vtx[vi * 8 + 1]; buf[dst+2] = vtx[vi * 8 + 2];
      buf[dst+3] = vtx[vi * 8 + 3]; buf[dst+4] = vtx[vi * 8 + 4]; buf[dst+5] = vtx[vi * 8 + 5];
      buf[dst+6] = baryCoords[corner][0];
      buf[dst+7] = baryCoords[corner][1];
      buf[dst+8] = baryCoords[corner][2];
      buf[dst+9] = vtx[vi * 8 + 6]; buf[dst+10] = vtx[vi * 8 + 7];
    }
  }
  return buf;
}

function createVertexBuffer(data: Float32Array) {
  const gpuBuf = device.createBuffer({
    size:  data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(gpuBuf, 0, data.buffer);
  return gpuBuf;
}

/* =========================================================================
   Procedural geometry generators
   ========================================================================= */

/** Latitude-longitude UV sphere. Returns indexed data (8 f32/vtx). */
function makeSphere(rings: number, segments: number): { vd: Float32Array; id: Uint32Array } {
  const verts: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    const cp  = Math.cos(phi), sp = Math.sin(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = 2 * Math.PI * s / segments;
      const px = sp * Math.cos(theta), py = cp, pz = sp * Math.sin(theta);
      verts.push(px, py, pz,  px, py, pz,  s / segments, r / rings);
    }
  }
  const tris: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + 1, c = a + (segments + 1), d = c + 1;
      tris.push(a, c, b,  b, c, d);
    }
  }
  return { vd: new Float32Array(verts), id: new Uint32Array(tris) };
}

/** Unit cube with per-face normals. Returns indexed data (8 f32/vtx). */
function makeCube(): { vd: Float32Array; id: Uint32Array } {
  type Face = { n: Vec3; v: number[][] };
  const faceList: Face[] = [
    { n: [ 0,  0,  1], v: [[-1,-1, 1,0,1],[1,-1, 1,1,1],[1, 1, 1,1,0],[-1, 1, 1,0,0]] },
    { n: [ 0,  0, -1], v: [[ 1,-1,-1,0,1],[-1,-1,-1,1,1],[-1, 1,-1,1,0],[1, 1,-1,0,0]] },
    { n: [-1,  0,  0], v: [[-1,-1,-1,0,1],[-1,-1, 1,1,1],[-1, 1, 1,1,0],[-1, 1,-1,0,0]] },
    { n: [ 1,  0,  0], v: [[ 1,-1, 1,0,1],[ 1,-1,-1,1,1],[ 1, 1,-1,1,0],[ 1, 1, 1,0,0]] },
    { n: [ 0,  1,  0], v: [[-1, 1, 1,0,1],[ 1, 1, 1,1,1],[ 1, 1,-1,1,0],[-1, 1,-1,0,0]] },
    { n: [ 0, -1,  0], v: [[-1,-1,-1,0,1],[ 1,-1,-1,1,1],[ 1,-1, 1,1,0],[-1,-1, 1,0,0]] },
  ];
  const verts: number[] = [], tris: number[] = [];
  let base = 0;
  for (const face of faceList) {
    for (const v of face.v) verts.push(v[0], v[1], v[2], ...face.n, v[3], v[4]);
    tris.push(base, base+1, base+2,  base, base+2, base+3);
    base += 4;
  }
  return { vd: new Float32Array(verts), id: new Uint32Array(tris) };
}

/* OBJ mesh loader */

interface MeshData {
  positions:     Float32Array;  // numVerts × 3
  normals:       Float32Array;  // numVerts × 3  (averaged from face normals)
  uvCoords:      Float32Array;  // numVerts × 2
  indices:       Uint32Array;   // numTris  × 3
  numVerts:      number;
  numTris:       number;
}

function sub3(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}
function cross3(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function norm3(v: [number,number,number]): [number,number,number] {
  const mag = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/mag, v[1]/mag, v[2]/mag];
}

/**
 * Parses OBJ text into a GPU-ready indexed mesh.
 * - Reads v / vt / f tokens; fan-triangulates quads and n-gons.
 * - Builds per-vertex normals by averaging surrounding face normals.
 * - Falls back to spherical UV projection when the file has no vt lines.
 */
function parseOBJText(text: string): MeshData {
  const rawPos:  [number,number,number][] = [];
  const rawUV:   [number,number][]        = [];
  type FaceVert = [number, number | null];
  const faces:   [FaceVert, FaceVert, FaceVert][] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const tok = line.split(/\s+/);

    if (tok[0] === "v") {
      rawPos.push([parseFloat(tok[1]), parseFloat(tok[2]), parseFloat(tok[3])]);
    } else if (tok[0] === "vt") {
      rawUV.push([parseFloat(tok[1]), parseFloat(tok[2])]);
    } else if (tok[0] === "f") {
      const corners = tok.slice(1).map(t => {
        const parts = t.split("/");
        const pi = parseInt(parts[0]) - 1;
        const ui = parts[1] && parts[1] !== "" ? parseInt(parts[1]) - 1 : null;
        return [pi, ui] as FaceVert;
      });
      // fan-triangulate: anchor at corners[0]
      for (let k = 1; k + 1 < corners.length; k++) {
        faces.push([corners[0], corners[k], corners[k + 1]]);
      }
    }
  }

  const nv      = rawPos.length;
  const nf      = faces.length;
  const hasUVs  = rawUV.length > 0;

  const pos  = new Float32Array(nv * 3);
  const nrm  = new Float32Array(nv * 3); // accumulated, normalized later
  const uv   = new Float32Array(nv * 2);
  const idx  = new Uint32Array(nf * 3);

  for (let i = 0; i < nv; i++) {
    pos[i*3]   = rawPos[i][0];
    pos[i*3+1] = rawPos[i][1];
    pos[i*3+2] = rawPos[i][2];
  }

  // Build indices, compute and accumulate face normals into vertex normals
  for (let f = 0; f < nf; f++) {
    const [[a, ua], [b, ub], [c, uc]] = faces[f];
    const fn = norm3(cross3(sub3(rawPos[b], rawPos[a]), sub3(rawPos[c], rawPos[a])));

    for (const vi of [a, b, c]) {
      nrm[vi*3]   += fn[0];
      nrm[vi*3+1] += fn[1];
      nrm[vi*3+2] += fn[2];
    }

    idx[f*3] = a; idx[f*3+1] = b; idx[f*3+2] = c;

    // Store UV from OBJ file (first assignment wins for shared vertices)
    if (hasUVs) {
      for (const [vi, ui] of [[a,ua],[b,ub],[c,uc]] as [number, number|null][]) {
        if (ui !== null && uv[vi*2] === 0 && uv[vi*2+1] === 0) {
          uv[vi*2]   = rawUV[ui][0];
          uv[vi*2+1] = 1 - rawUV[ui][1]; // flip V axis for WebGPU
        }
      }
    }
  }

  // Normalize accumulated vertex normals
  for (let i = 0; i < nv; i++) {
    const mag = Math.hypot(nrm[i*3], nrm[i*3+1], nrm[i*3+2]) || 1;
    nrm[i*3]   /= mag;
    nrm[i*3+1] /= mag;
    nrm[i*3+2] /= mag;
  }

  // Spherical UV projection fallback: u = longitude, v = latitude
  if (!hasUVs) {
    for (let i = 0; i < nv; i++) {
      const nx = nrm[i*3], ny = nrm[i*3+1], nz = nrm[i*3+2];
      uv[i*2]   = 0.5 + Math.atan2(nz, nx) / (2 * Math.PI);
      uv[i*2+1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
    }
  }

  return { positions: pos, normals: nrm, uvCoords: uv, indices: idx, numVerts: nv, numTris: nf };
}

/** Interleave pos + normal + uv into 8 f32/vtx for use with buildFlatBuffer. */
function interleaveVertexData(mesh: MeshData): { vd: Float32Array; id: Uint32Array } {
  const vd = new Float32Array(mesh.numVerts * 8);
  for (let i = 0; i < mesh.numVerts; i++) {
    vd[i*8]   = mesh.positions[i*3];   vd[i*8+1] = mesh.positions[i*3+1]; vd[i*8+2] = mesh.positions[i*3+2];
    vd[i*8+3] = mesh.normals[i*3];     vd[i*8+4] = mesh.normals[i*3+1];   vd[i*8+5] = mesh.normals[i*3+2];
    vd[i*8+6] = mesh.uvCoords[i*2];    vd[i*8+7] = mesh.uvCoords[i*2+1];
  }
  return { vd, id: mesh.indices };
}

/** Compute bounding sphere (center + radius) from an axis-aligned bounding box. */
function computeBoundingSphere(mesh: MeshData): { center: Vec3; radius: number } {
  let xMin = Infinity, yMin = Infinity, zMin = Infinity;
  let xMax = -Infinity, yMax = -Infinity, zMax = -Infinity;

  for (let i = 0; i < mesh.numVerts; i++) {
    const x = mesh.positions[i*3], y = mesh.positions[i*3+1], z = mesh.positions[i*3+2];
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }

  const cx = (xMin + xMax) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  const cz = (zMin + zMax) * 0.5;
  let radius = 0;

  for (let i = 0; i < mesh.numVerts; i++) {
    const dx = mesh.positions[i*3] - cx;
    const dy = mesh.positions[i*3+1] - cy;
    const dz = mesh.positions[i*3+2] - cz;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist > radius) radius = dist;
  }

  return { center: [cx, cy, cz], radius };
}

/* SceneObject — wraps one drawable mesh with its GPU resources */

interface ObjectTransform {
  tx: number; ty: number; tz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
}
interface SurfaceMaterial {
  ambient: number; diffuse: number; specular: number; shininess: number;
  color: string;
}

function zeroTransform(): ObjectTransform {
  return { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, sx:1, sy:1, sz:1 };
}
function baseMaterial(): SurfaceMaterial {
  return { ambient:0.12, diffuse:0.75, specular:0.55, shininess:48, color:"#4a9eff" };
}

let uidCounter = 0;

class MeshObject {
  readonly uid = uidCounter++;
  label:  string;
  gpuVtx: ReturnType<typeof device.createBuffer>;
  drawCount:  number;
  gpuUBO:     ReturnType<typeof device.createBuffer>;
  albedo:     ReturnType<typeof device.createTexture>;
  bindGroup:  ReturnType<typeof device.createBindGroup>;
  useTexture  = 0;
  xform:    ObjectTransform;
  material: SurfaceMaterial;
  savedQuat: [number,number,number,number] = [0,0,0,1];

  private uboBuffer  = new ArrayBuffer(UBO_BYTES);
  private uboF32     = new Float32Array(this.uboBuffer);
  private uboU32     = new Uint32Array(this.uboBuffer);

  constructor(label: string, gpuVtx: ReturnType<typeof device.createBuffer>, drawCount: number) {
    this.label     = label;
    this.gpuVtx    = gpuVtx;
    this.drawCount = drawCount;
    this.xform     = zeroTransform();
    this.material  = baseMaterial();
    this.albedo    = createBlankTexture();
    this.gpuUBO    = device.createBuffer({ size: UBO_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = this._buildBindGroup();
  }

  /** World-space center (translation component of transform). */
  center(): Vec3 { return [this.xform.tx, this.xform.ty, this.xform.tz]; }

  assignTexture(tex: ReturnType<typeof device.createTexture>): void {
    this.albedo.destroy();
    this.albedo    = tex;
    this.useTexture = 1;
    this.bindGroup = this._buildBindGroup();
  }

  /** Compose TRS matrix: Translation × (Euler rotations × arcball) × Scale. */
  modelMatrix(arcball: Mat4): Mat4 {
    const { tx,ty,tz, rx,ry,rz, sx,sy,sz } = this.xform;
    const T = mat4.translation(tx, ty, tz);
    const S = mat4.scaling(sx, sy, sz);
    const R = mat4.multiply(
      mat4.rotationZ(rz),
      mat4.multiply(mat4.rotationY(ry), mat4.multiply(mat4.rotationX(rx), arcball)),
    );
    return mat4.multiply(T, mat4.multiply(R, S));
  }

  /** Pack all per-object uniforms and upload to the GPU uniform buffer. */
  syncUniforms(
    arcball:    Mat4,
    view:       Mat4,
    proj:       Mat4,
    lightPos:   Vec3,
    lightRGB:   Vec3,
    camPos:     Vec3,
    renderMode: number,
    time:       number,
    selected:   boolean,
  ): void {
    const M       = this.modelMatrix(arcball);
    const normalM = mat4.normalMatrix(M);
    const MVP     = mat4.multiply(proj, mat4.multiply(view, M));

    const [lr, lg, lb] = lightRGB;
    const mat           = this.material;
    const [cr, cg, cb] = hexToRgb(mat.color);
    const f = this.uboF32, u = this.uboU32;

    f.set(MVP,     0);
    f.set(M,      16);
    f.set(normalM,32);
    f.set(view,   48);

    f[64] = lightPos[0]; f[65] = lightPos[1]; f[66] = lightPos[2]; f[67] = 0;
    f[68] = lr;          f[69] = lg;          f[70] = lb;          f[71] = 0;
    f[72] = mat.ambient; f[73] = mat.diffuse;  f[74] = mat.specular; f[75] = mat.shininess;
    f[76] = camPos[0];   f[77] = camPos[1];    f[78] = camPos[2];
    u[79] = renderMode;
    f[80] = cr;          f[81] = cg;           f[82] = cb;
    u[83] = this.useTexture;
    f[84] = time;
    u[85] = selected ? 1 : 0;

    device.queue.writeBuffer(this.gpuUBO, 0, this.uboBuffer);
  }

  free(): void {
    this.gpuVtx.destroy();
    this.gpuUBO.destroy();
    this.albedo.destroy();
  }

  private _buildBindGroup() {
    return device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.gpuUBO } },
        { binding: 1, resource: trilinearSampler },
        { binding: 2, resource: this.albedo.createView() },
      ],
    });
  }
}

/* Scene object creation helpers  */

function spawnMesh(label: string, vd: Float32Array, id: Uint32Array): MeshObject {
  return new MeshObject(label, createVertexBuffer(buildFlatBuffer(vd, id)), id.length);
}

async function importOBJ(name: string, text: string): Promise<MeshObject> {
  const mesh        = parseOBJText(text);
  const { vd, id }  = interleaveVertexData(mesh);
  const obj         = spawnMesh(name, vd, id);
  const bs          = computeBoundingSphere(mesh);
  // Translate so the bounding-sphere center lands at the world origin
  obj.xform.tx = -bs.center[0];
  obj.xform.ty = -bs.center[1];
  obj.xform.tz = -bs.center[2];
  cam.fitCamera(bs.center, bs.radius);
  return obj;
}

/* Scene state  */

const scene: MeshObject[] = [];
let activeIdx = -1;
const cam = new ArcballCamera(canvas);
cam.objectSelected = false;

/** Returns the orbit target — the selected object's center or the world origin. */
function orbitTarget(): Vec3 {
  return activeIdx >= 0 && scene[activeIdx] ? scene[activeIdx].center() : [0, 0, 0];
}

function setActive(idx: number): void {
  if (activeIdx >= 0 && scene[activeIdx]) {
    scene[activeIdx].savedQuat = cam.saveRotation();
  }
  activeIdx = idx;
  if (idx >= 0 && scene[idx]) {
    cam.objectSelected = true;
    cam.loadRotation(scene[idx].savedQuat);
  } else {
    cam.objectSelected = false;
  }
  rebuildObjectList();
  syncInspector();
}

function addToScene(obj: MeshObject): void {
  scene.push(obj);
  setActive(scene.length - 1);
}

function deleteActive(): void {
  if (activeIdx < 0 || scene.length === 0) return;
  scene[activeIdx].savedQuat = cam.saveRotation();
  scene[activeIdx].free();
  scene.splice(activeIdx, 1);
  setActive(scene.length === 0 ? -1 : Math.max(0, activeIdx - 1));
}

/*   GUI */

const appState = { renderMode: 1, lightColor: "#ffffff" };

function hexToRgb(hex: string): [number, number, number] {
  const val = parseInt(hex.slice(1), 16);
  return [(val >> 16 & 255) / 255, (val >> 8 & 255) / 255, (val & 255) / 255];
}

function rangeInput(id: string, label: string, min: number, max: number, step: number, val: number): string {
  const disp = Number.isInteger(val) ? String(val) : val.toFixed(2);
  return `<div class="slider-row">
    <span class="slider-label">${label}</span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">
    <span class="slider-val" id="${id}-val">${disp}</span></div>`;
}

const RENDER_MODE_LABELS: Record<number, string> = {
  0: "Gouraud: lighting computed per vertex, colour interpolated across face.",
  1: "Phong: normals interpolated per fragment, full lighting per pixel.",
  2: "Normal buffer: world-space normals encoded as RGB (R=X  G=Y  B=Z).",
  3: "Wireframe: black edges on white background. Depth buffer removes hidden surfaces.",
  4: "Depth: linearised NDC depth shown as greyscale.",
  5: "Texture: spherical UV map multiplied by Phong shading.",
  6: "UV visualiser: U channel → Red,  V channel → Green.",
};

const guiContainer = document.createElement("div");
guiContainer.id = "gui";
guiContainer.innerHTML = `
<div class="gui-panel" id="panel-left">
  <div class="gui-title">Pipeline</div>
  <div class="gui-section">
    <div class="gui-label">Add Object</div>
    <div class="btn-row">
      <button id="add-sphere">Sphere</button>
      <button id="add-cube">Cube</button>
    </div>
    <div class="gui-label" style="margin-top:6px">Upload OBJ</div>
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
    <div class="gui-label" id="inspector-title">No selection — camera orbit mode</div>
    <div class="gui-label">Transform</div>
    ${rangeInput("tr-tx","Translate X",-12,12,.05,0)}
    ${rangeInput("tr-ty","Translate Y",-12,12,.05,0)}
    ${rangeInput("tr-tz","Translate Z",-12,12,.05,0)}
    ${rangeInput("tr-rx","Rotate X",-3.15,3.15,.01,0)}
    ${rangeInput("tr-ry","Rotate Y",-3.15,3.15,.01,0)}
    ${rangeInput("tr-rz","Rotate Z",-3.15,3.15,.01,0)}
    ${rangeInput("tr-sx","Scale X",.05,6,.05,1)}
    ${rangeInput("tr-sy","Scale Y",.05,6,.05,1)}
    ${rangeInput("tr-sz","Scale Z",.05,6,.05,1)}
    <div class="gui-label">Material</div>
    ${rangeInput("mt-ambient","Ambient (Ka)",0,1,.01,.12)}
    ${rangeInput("mt-diffuse","Diffuse (Kd)",0,1,.01,.75)}
    ${rangeInput("mt-specular","Specular (Ks)",0,1,.01,.55)}
    ${rangeInput("mt-shine","Shininess (n)",1,256,1,48)}
    <div class="color-row" style="margin-top:4px">
      <span>Object color</span><input type="color" id="mt-color" value="#4a9eff">
    </div>
    <div class="gui-label">Texture (spherical UV)</div>
    <input type="file" id="tex-upload" accept="image/*" class="file-input">
    <label class="checkbox-row"><input type="checkbox" id="use-texture"> Use texture</label>
  </div>
</div>`;
document.body.appendChild(guiContainer);

// Render mode button wiring
function updateModeLabel(): void {
  document.getElementById("mode-desc")!.textContent = RENDER_MODE_LABELS[appState.renderMode];
}
updateModeLabel();

document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    appState.renderMode = Number(btn.dataset.id);
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    updateModeLabel();
  });
});

// Add procedural objects
document.getElementById("add-sphere")!.addEventListener("click", () => {
  addToScene(spawnMesh("Sphere", ...Object.values(makeSphere(64, 64)) as [Float32Array, Uint32Array]));
});
document.getElementById("add-cube")!.addEventListener("click", () => {
  addToScene(spawnMesh("Cube", ...Object.values(makeCube()) as [Float32Array, Uint32Array]));
});

// OBJ file upload
document.getElementById("obj-upload")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  addToScene(await importOBJ(file.name.replace(".obj", ""), await file.text()));
});

// Scene management buttons
document.getElementById("btn-deselect")!.addEventListener("click", () => setActive(-1));
document.getElementById("btn-remove")!.addEventListener("click",   deleteActive);

// Global light color picker
document.getElementById("g-lightColor")!.addEventListener("input", (e) => {
  appState.lightColor = (e.target as HTMLInputElement).value;
});

// Object list panel
function rebuildObjectList(): void {
  const panel = document.getElementById("object-list")!;
  panel.innerHTML = "";
  scene.forEach((obj, i) => {
    const btn = document.createElement("button");
    btn.className  = "obj-list-btn" + (i === activeIdx ? " active" : "");
    btn.textContent = `${i + 1}. ${obj.label}`;
    btn.addEventListener("click", () => setActive(i === activeIdx ? -1 : i));
    panel.appendChild(btn);
  });
}

// Inspector helpers
function writeSlider(id: string, val: number): void {
  const el  = document.getElementById(id) as HTMLInputElement | null;
  const lbl = document.getElementById(`${id}-val`);
  if (el)  el.value = String(val);
  if (lbl) lbl.textContent = Number.isInteger(val) ? String(val) : val.toFixed(2);
}

function syncInspector(): void {
  const title = document.getElementById("inspector-title")!;
  if (activeIdx < 0 || !scene[activeIdx]) {
    title.textContent = "No selection — camera orbit mode";
    return;
  }
  const obj = scene[activeIdx];
  title.textContent = obj.label;
  const t = obj.xform;
  writeSlider("tr-tx", t.tx); writeSlider("tr-ty", t.ty); writeSlider("tr-tz", t.tz);
  writeSlider("tr-rx", t.rx); writeSlider("tr-ry", t.ry); writeSlider("tr-rz", t.rz);
  writeSlider("tr-sx", t.sx); writeSlider("tr-sy", t.sy); writeSlider("tr-sz", t.sz);
  const m = obj.material;
  writeSlider("mt-ambient", m.ambient); writeSlider("mt-diffuse", m.diffuse);
  writeSlider("mt-specular", m.specular); writeSlider("mt-shine", m.shininess);
  (document.getElementById("mt-color") as HTMLInputElement).value = m.color;
  (document.getElementById("use-texture") as HTMLInputElement).checked = obj.useTexture === 1;
}

// Slider wiring
function bindSlider(id: string, apply: (obj: MeshObject, v: number) => void): void {
  const el  = document.getElementById(id) as HTMLInputElement;
  const lbl = document.getElementById(`${id}-val`);
  if (!el) return;
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    if (lbl) lbl.textContent = Number.isInteger(v) ? String(v) : v.toFixed(2);
    if (activeIdx >= 0 && scene[activeIdx]) apply(scene[activeIdx], v);
  });
}

bindSlider("tr-tx", (o,v) => { o.xform.tx = v; });
bindSlider("tr-ty", (o,v) => { o.xform.ty = v; });
bindSlider("tr-tz", (o,v) => { o.xform.tz = v; });
bindSlider("tr-rx", (o,v) => { o.xform.rx = v; });
bindSlider("tr-ry", (o,v) => { o.xform.ry = v; });
bindSlider("tr-rz", (o,v) => { o.xform.rz = v; });
bindSlider("tr-sx", (o,v) => { o.xform.sx = v; });
bindSlider("tr-sy", (o,v) => { o.xform.sy = v; });
bindSlider("tr-sz", (o,v) => { o.xform.sz = v; });
bindSlider("mt-ambient",  (o,v) => { o.material.ambient   = v; });
bindSlider("mt-diffuse",  (o,v) => { o.material.diffuse   = v; });
bindSlider("mt-specular", (o,v) => { o.material.specular  = v; });
bindSlider("mt-shine",    (o,v) => { o.material.shininess = v; });

(document.getElementById("mt-color") as HTMLInputElement).addEventListener("input", (e) => {
  if (activeIdx >= 0 && scene[activeIdx])
    scene[activeIdx].material.color = (e.target as HTMLInputElement).value;
});

// Texture upload
document.getElementById("tex-upload")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || activeIdx < 0 || !scene[activeIdx]) return;
  const bmp = await createImageBitmap(file, { colorSpaceConversion: "none" });
  const tex = device.createTexture({
    size: [bmp.width, bmp.height], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
  scene[activeIdx].assignTexture(tex);
  (document.getElementById("use-texture") as HTMLInputElement).checked = true;
});

(document.getElementById("use-texture") as HTMLInputElement).addEventListener("change", (e) => {
  if (activeIdx >= 0 && scene[activeIdx])
    scene[activeIdx].useTexture = (e.target as HTMLInputElement).checked ? 1 : 0;
});

/* Seed scene with a default sphere and cube  */
{
  const { vd, id } = makeSphere(64, 64);
  const s = spawnMesh("Sphere", vd, id);
  s.xform.tx = -2.5;
  scene.push(s);
}
{
  const { vd, id } = makeCube();
  const c = spawnMesh("Cube", vd, id);
  c.xform.tx = 2.5;
  scene.push(c);
}
activeIdx = -1;
cam.objectSelected = false;
rebuildObjectList();
syncInspector();

/* Render loop */
const t0 = performance.now();

function renderFrame(now: number): void {
  const elapsed = (now - t0) / 1000;
  const aspect  = canvas.width / canvas.height;
  const [near, far] = cam.getNearFar();
  const proj = mat4.perspective((60 * Math.PI) / 180, aspect, near, far);

  const lightRGB: Vec3 = hexToRgb(appState.lightColor);
  const target  = orbitTarget();
  const view    = cam.getViewMatrix(target);
  const camPos  = cam.getCamPos(target);

  // Light floats 5 units above the camera position in world space
  const lightPos: Vec3 = [camPos[0], camPos[1] + 5, camPos[2]];

  const identityMat = quatToMat4([0, 0, 0, 1]);
  const activeRot   = activeIdx >= 0 && scene[activeIdx]
    ? cam.getObjectRotationMatrix()
    : identityMat;

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view:       ctx.getCurrentTexture().createView(),
      clearValue: { r: 0.08, g: 0.08, b: 0.12, a: 1 },
      loadOp: "clear", storeOp: "store",
    }],
    depthStencilAttachment: {
      view:            depthTex!.createView(),
      depthClearValue: 1,
      depthLoadOp:  "clear",
      depthStoreOp: "store",
    },
  });

  pass.setPipeline(renderPipeline);

  for (let i = 0; i < scene.length; i++) {
    const obj      = scene[i];
    const isActive = i === activeIdx;
    const rot      = isActive ? activeRot : quatToMat4(obj.savedQuat);
    obj.syncUniforms(rot, view, proj, lightPos, lightRGB, camPos, appState.renderMode, elapsed, isActive);
    pass.setBindGroup(0, obj.bindGroup);
    pass.setVertexBuffer(0, obj.gpuVtx);
    pass.draw(obj.drawCount);
  }

  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);
