export type Vec3 = [number, number, number];
export type Mat4 = Float32Array; // column-major

export const vec3 = {
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(v: Vec3, s: number): Vec3 {
    return [v[0] * s, v[1] * s, v[2] * s];
  },
  dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
  normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  },
};

export const mat4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
  },

  multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },

  transpose(a: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        out[c * 4 + r] = a[r * 4 + c];
    return out;
  },

  /** Returns the inverse of a 4×4 matrix (column-major). */
  invert(m: Mat4): Mat4 {
    const out = new Float32Array(16);
    const
      a00 = m[0],  a10 = m[1],  a20 = m[2],  a30 = m[3],
      a01 = m[4],  a11 = m[5],  a21 = m[6],  a31 = m[7],
      a02 = m[8],  a12 = m[9],  a22 = m[10], a32 = m[11],
      a03 = m[12], a13 = m[13], a23 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a10 * a01;
    const b01 = a00 * a21 - a20 * a01;
    const b02 = a00 * a31 - a30 * a01;
    const b03 = a10 * a21 - a20 * a11;
    const b04 = a10 * a31 - a30 * a11;
    const b05 = a20 * a31 - a30 * a21;
    const b06 = a02 * a13 - a12 * a03;
    const b07 = a02 * a23 - a22 * a03;
    const b08 = a02 * a33 - a32 * a03;
    const b09 = a12 * a23 - a22 * a13;
    const b10 = a12 * a33 - a32 * a13;
    const b11 = a22 * a33 - a32 * a23;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return mat4.identity();
    det = 1.0 / det;

    out[0]  = (a11 * b11 - a21 * b10 + a31 * b09) * det;
    out[1]  = (a21 * b08 - a01 * b11 - a31 * b07) * det;
    out[2]  = (a01 * b10 - a11 * b08 + a31 * b06) * det;
    out[3]  = (a11 * b07 - a01 * b09 - a21 * b06) * det;
    out[4]  = (a20 * b10 - a10 * b11 - a30 * b09) * det;
    out[5]  = (a00 * b11 - a20 * b08 + a30 * b07) * det;
    out[6]  = (a10 * b08 - a00 * b10 - a30 * b06) * det;
    out[7]  = (a00 * b09 - a10 * b07 + a20 * b06) * det;
    out[8]  = (a13 * b05 - a23 * b04 + a33 * b03) * det;
    out[9]  = (a23 * b02 - a03 * b05 - a33 * b01) * det;
    out[10] = (a03 * b04 - a13 * b02 + a33 * b00) * det;
    out[11] = (a13 * b01 - a03 * b03 - a23 * b00) * det;
    out[12] = (a22 * b04 - a12 * b05 - a32 * b03) * det;
    out[13] = (a02 * b05 - a22 * b02 + a32 * b01) * det;
    out[14] = (a12 * b02 - a02 * b04 - a32 * b00) * det;
    out[15] = (a02 * b03 - a12 * b01 + a22 * b00) * det;

    return out;
  },

  /** Normal matrix = transpose(inverse(model)) */
  normalMatrix(model: Mat4): Mat4 {
    return mat4.transpose(mat4.invert(model));
  },

  translation(tx: number, ty: number, tz: number): Mat4 {
    const m = mat4.identity();
    m[12] = tx; m[13] = ty; m[14] = tz;
    return m;
  },

  scaling(sx: number, sy: number, sz: number): Mat4 {
    const m = mat4.identity();
    m[0] = sx; m[5] = sy; m[10] = sz;
    return m;
  },

  rotationX(rad: number): Mat4 {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = mat4.identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  },

  rotationY(rad: number): Mat4 {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = mat4.identity();
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  },

  rotationZ(rad: number): Mat4 {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = mat4.identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  },

  perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1.0 / Math.tan(fovyRad / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / (near - far);
    m[11] = -1;
    m[14] = (far * near) / (near - far);
    return m;
  },

  lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const z = vec3.normalize(vec3.sub(eye, target));
    const x = vec3.normalize(vec3.cross(up, z));
    const y = vec3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[4] = x[1]; m[8]  = x[2]; m[12] = -vec3.dot(x, eye);
    m[1] = y[0]; m[5] = y[1]; m[9]  = y[2]; m[13] = -vec3.dot(y, eye);
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2]; m[14] = -vec3.dot(z, eye);
    m[3] = 0;    m[7] = 0;    m[11] = 0;    m[15] = 1;
    return m;
  },
};
