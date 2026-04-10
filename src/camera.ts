import type { Mat4, Vec3 } from "./math";
import { mat4 } from "./math";

// ── Quaternion helpers ────────────────────────────────────────────────────────
// Convention: [x, y, z, w]
type Quat = [number, number, number, number];

function quatIdentity(): Quat { return [0, 0, 0, 1]; }

function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function quatToMat4(q: Quat): Mat4 {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0]  = 1 - 2 * (y * y + z * z); m[4]  = 2 * (x * y - z * w); m[8]  = 2 * (x * z + y * w); m[12] = 0;
  m[1]  = 2 * (x * y + z * w);     m[5]  = 1 - 2 * (x * x + z * z); m[9]  = 2 * (y * z - x * w); m[13] = 0;
  m[2]  = 2 * (x * z - y * w);     m[6]  = 2 * (y * z + x * w);     m[10] = 1 - 2 * (x * x + y * y); m[14] = 0;
  m[3]  = 0;                        m[7]  = 0;                        m[11] = 0;                        m[15] = 1;
  return m;
}

// Map 2-D NDC point to point on the unit arcball sphere.
// Inside unit circle → lift onto sphere; outside → project onto equator.
function mapToSphere(x: number, y: number): [number, number, number] {
  const d = x * x + y * y;
  if (d <= 1) return [x, y, Math.sqrt(1 - d)];
  const r = Math.sqrt(d);
  return [x / r, y / r, 0];
}

// Quaternion that rotates p0 to p1 on the unit sphere.
function arcballQuat(p0: [number, number, number], p1: [number, number, number]): Quat {
  const [sx, sy, sz] = p0, [ex, ey, ez] = p1;
  const cosAngle = Math.min(1, sx * ex + sy * ey + sz * ez);
  const angle    = Math.acos(cosAngle);
  if (angle < 1e-6) return quatIdentity();
  // axis = p0 × p1
  const cx = sy * ez - sz * ey;
  const cy = sz * ex - sx * ez;
  const cz = sx * ey - sy * ex;
  const len = Math.hypot(cx, cy, cz);
  if (len < 1e-10) return quatIdentity();
  const s = Math.sin(angle * 0.5) / len;
  return quatNormalize([cx * s, cy * s, cz * s, Math.cos(angle * 0.5)]);
}

// ── ArcballCamera ─────────────────────────────────────────────────────────────
export class ArcballCamera {
  // Object rotation (accumulated quaternion + in-flight drag)
  private rotation:     Quat = quatIdentity();
  private dragRotation: Quat = quatIdentity();
  private dragStart:    [number, number, number] | null = null;

  // Orbit camera spherical coordinates
  private camAzimuth   = 0;
  private camElevation = 0.3;
  private camDragging  = false;
  private camDragLastX = 0;
  private camDragLastY = 0;

  private _distance = 9;
  private _radius   = 1; // used to clamp minimum zoom distance
  private _far      = 30; // fixed far plane; set by fitCamera

  /** When true, mouse drag rotates the selected object; otherwise orbits camera. */
  objectSelected = false;

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this._bindEvents();
  }

  // ── Camera query ─────────────────────────────────────────────────────────────

  get distance(): number { return this._distance; }

  /** Returns a copy of the current object rotation (commits any in-flight drag). */
  saveRotation(): Quat {
    this._commitDrag();
    return [...this.rotation] as Quat;
  }

  /** Restores a previously saved object rotation. */
  loadRotation(q: Quat): void {
    this.rotation     = [...q] as Quat;
    this.dragRotation = quatIdentity();
    this.dragStart    = null;
  }

  /** Returns the object rotation matrix (drag * saved), suitable for the vertex shader. */
  getObjectRotationMatrix(): Mat4 {
    return quatToMat4(quatNormalize(quatMultiply(this.dragRotation, this.rotation)));
  }

  /** View matrix: camera orbits around `target` at the current distance / angles. */
  getViewMatrix(target: Vec3): Mat4 {
    const o = this._eyeOffset();
    const eye: Vec3 = [target[0] + o[0], target[1] + o[1], target[2] + o[2]];
    return mat4.lookAt(eye, target, [0, 1, 0]);
  }

  /** World-space camera position (same geometry as getViewMatrix). */
  getCamPos(target: Vec3): Vec3 {
    const o = this._eyeOffset();
    return [target[0] + o[0], target[1] + o[1], target[2] + o[2]];
  }

  /**
   * Computes a near/far pair that tightly brackets the object so the depth buffer
   * is never wasted and there is no clipping as long as the camera stays outside
   * the bounding sphere.
   */
  getNearFar(): [number, number] {
    // Near: 1% of camera distance — never clips through objects regardless of radius.
    // Far:  fixed value set at fitCamera time so objects disappear on extreme zoom-out.
    const near = Math.max(0.001, this._distance * 0.01);
    return [near, this._far];
  }

  /**
   * Positions the camera so the bounding sphere with the given `center` and
   * `radius` fills the view.  Call this after loading a new mesh.
   */
  fitCamera(center: Vec3, radius: number): void {
    void center; // center is used implicitly by the caller via worldPos
    this._radius   = radius;
    this._distance = radius * 2.5;
    this._far      = radius * 10;
    this.camAzimuth   = 0;
    this.camElevation = 0.3;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _eyeOffset(): Vec3 {
    const cosE = Math.cos(this.camElevation);
    const sinE = Math.sin(this.camElevation);
    const cosA = Math.cos(this.camAzimuth);
    const sinA = Math.sin(this.camAzimuth);
    return [
      this._distance * cosE * sinA,
      this._distance * sinE,
      this._distance * cosE * cosA,
    ];
  }

  private _commitDrag(): void {
    if (this.dragStart) {
      this.rotation     = quatNormalize(quatMultiply(this.dragRotation, this.rotation));
      this.dragRotation = quatIdentity();
      this.dragStart    = null;
    }
  }

  private _toNDC(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [
       (clientX - r.left) / r.width  * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    ];
  }

  private _bindEvents(): void {
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = this._toNDC(e.clientX, e.clientY);
      const p = mapToSphere(x, y);
      if (this.objectSelected) {
        this.dragStart    = p;
        this.dragRotation = quatIdentity();
      } else {
        this.camDragging  = true;
        this.camDragLastX = x;
        this.camDragLastY = y;
      }
    });

    this.canvas.addEventListener("mousemove", (e) => {
      const [x, y] = this._toNDC(e.clientX, e.clientY);
      const p = mapToSphere(x, y);
      if (this.objectSelected && this.dragStart) {
        this.dragRotation = arcballQuat(this.dragStart, p);
      } else if (!this.objectSelected && this.camDragging) {
        const dx = x - this.camDragLastX;
        const dy = y - this.camDragLastY;
        this.camAzimuth   += dx * Math.PI;
        this.camElevation  = Math.max(
          -Math.PI / 2 + 0.01,
          Math.min(Math.PI / 2 - 0.01, this.camElevation + dy * Math.PI),
        );
        this.camDragLastX = x;
        this.camDragLastY = y;
      }
    });

    const onUp = () => {
      if (this.objectSelected && this.dragStart) {
        this.rotation     = quatNormalize(quatMultiply(this.dragRotation, this.rotation));
        this.dragRotation = quatIdentity();
        this.dragStart    = null;
      } else if (!this.objectSelected) {
        this.camDragging = false;
      }
    };
    this.canvas.addEventListener("mouseup",    onUp);
    this.canvas.addEventListener("mouseleave", onUp);

    // Scroll to zoom — clamp minimum distance to avoid entering the mesh
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._distance *= 1 + e.deltaY * 0.001;
      this._distance  = Math.max(this._radius * 1.05 || 0.5, this._distance);
    }, { passive: false });
  }
}
