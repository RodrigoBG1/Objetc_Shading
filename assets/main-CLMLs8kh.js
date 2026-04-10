(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))o(r);new MutationObserver(r=>{for(const i of r)if(i.type==="childList")for(const s of i.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&o(s)}).observe(document,{childList:!0,subtree:!0});function n(r){const i={};return r.integrity&&(i.integrity=r.integrity),r.referrerPolicy&&(i.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?i.credentials="include":r.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function o(r){if(r.ep)return;r.ep=!0;const i=n(r);fetch(r.href,i)}})();const mt=`// =============================================================================
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
`,A={add(e,t){return[e[0]+t[0],e[1]+t[1],e[2]+t[2]]},sub(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]},scale(e,t){return[e[0]*t,e[1]*t,e[2]*t]},dot(e,t){return e[0]*t[0]+e[1]*t[1]+e[2]*t[2]},cross(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]},normalize(e){const t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]}},x={identity(){const e=new Float32Array(16);return e[0]=1,e[5]=1,e[10]=1,e[15]=1,e},multiply(e,t){const n=new Float32Array(16);for(let o=0;o<4;o++)for(let r=0;r<4;r++)n[o*4+r]=e[0+r]*t[o*4+0]+e[4+r]*t[o*4+1]+e[8+r]*t[o*4+2]+e[12+r]*t[o*4+3];return n},transpose(e){const t=new Float32Array(16);for(let n=0;n<4;n++)for(let o=0;o<4;o++)t[o*4+n]=e[n*4+o];return t},invert(e){const t=new Float32Array(16),n=e[0],o=e[1],r=e[2],i=e[3],s=e[4],l=e[5],c=e[6],d=e[7],g=e[8],a=e[9],u=e[10],f=e[11],h=e[12],y=e[13],b=e[14],_=e[15],w=n*l-o*s,M=n*c-r*s,m=n*d-i*s,B=o*c-r*l,R=o*d-i*l,N=r*d-i*c,T=g*y-a*h,F=g*b-u*h,O=g*_-f*h,V=a*b-u*y,D=a*_-f*y,G=u*_-f*b;let C=w*G-M*D+m*V+B*O-R*F+N*T;return C?(C=1/C,t[0]=(l*G-c*D+d*V)*C,t[1]=(c*O-s*G-d*F)*C,t[2]=(s*D-l*O+d*T)*C,t[3]=(l*F-s*V-c*T)*C,t[4]=(r*D-o*G-i*V)*C,t[5]=(n*G-r*O+i*F)*C,t[6]=(o*O-n*D-i*T)*C,t[7]=(n*V-o*F+r*T)*C,t[8]=(y*N-b*R+_*B)*C,t[9]=(b*m-h*N-_*M)*C,t[10]=(h*R-y*m+_*w)*C,t[11]=(y*M-h*B-b*w)*C,t[12]=(u*R-a*N-f*B)*C,t[13]=(g*N-u*m+f*M)*C,t[14]=(a*m-g*R-f*w)*C,t[15]=(g*B-a*M+u*w)*C,t):x.identity()},normalMatrix(e){return x.transpose(x.invert(e))},translation(e,t,n){const o=x.identity();return o[12]=e,o[13]=t,o[14]=n,o},scaling(e,t,n){const o=x.identity();return o[0]=e,o[5]=t,o[10]=n,o},rotationX(e){const t=Math.cos(e),n=Math.sin(e),o=x.identity();return o[5]=t,o[6]=n,o[9]=-n,o[10]=t,o},rotationY(e){const t=Math.cos(e),n=Math.sin(e),o=x.identity();return o[0]=t,o[2]=-n,o[8]=n,o[10]=t,o},rotationZ(e){const t=Math.cos(e),n=Math.sin(e),o=x.identity();return o[0]=t,o[1]=n,o[4]=-n,o[5]=t,o},perspective(e,t,n,o){const r=1/Math.tan(e/2),i=new Float32Array(16);return i[0]=r/t,i[5]=r,i[10]=o/(n-o),i[11]=-1,i[14]=o*n/(n-o),i},lookAt(e,t,n){const o=A.normalize(A.sub(e,t)),r=A.normalize(A.cross(n,o)),i=A.cross(o,r),s=new Float32Array(16);return s[0]=r[0],s[4]=r[1],s[8]=r[2],s[12]=-A.dot(r,e),s[1]=i[0],s[5]=i[1],s[9]=i[2],s[13]=-A.dot(i,e),s[2]=o[0],s[6]=o[1],s[10]=o[2],s[14]=-A.dot(o,e),s[3]=0,s[7]=0,s[11]=0,s[15]=1,s}};function j(){return[0,0,0,1]}function X(e,t){const[n,o,r,i]=e,[s,l,c,d]=t;return[i*s+n*d+o*c-r*l,i*l-n*c+o*d+r*s,i*c+n*l-o*s+r*d,i*d-n*s-o*l-r*c]}function k(e){const t=Math.hypot(e[0],e[1],e[2],e[3])||1;return[e[0]/t,e[1]/t,e[2]/t,e[3]/t]}function q(e){const[t,n,o,r]=e,i=new Float32Array(16);return i[0]=1-2*(n*n+o*o),i[4]=2*(t*n-o*r),i[8]=2*(t*o+n*r),i[12]=0,i[1]=2*(t*n+o*r),i[5]=1-2*(t*t+o*o),i[9]=2*(n*o-t*r),i[13]=0,i[2]=2*(t*o-n*r),i[6]=2*(n*o+t*r),i[10]=1-2*(t*t+n*n),i[14]=0,i[3]=0,i[7]=0,i[11]=0,i[15]=1,i}function K(e,t){const n=e*e+t*t;if(n<=1)return[e,t,Math.sqrt(1-n)];const o=Math.sqrt(n);return[e/o,t/o,0]}function ht(e,t){const[n,o,r]=e,[i,s,l]=t,c=Math.min(1,n*i+o*s+r*l),d=Math.acos(c);if(d<1e-6)return j();const g=o*l-r*s,a=r*i-n*l,u=n*s-o*i,f=Math.hypot(g,a,u);if(f<1e-10)return j();const h=Math.sin(d*.5)/f;return k([g*h,a*h,u*h,Math.cos(d*.5)])}class pt{rotation=j();dragRotation=j();dragStart=null;camAzimuth=0;camElevation=.3;camDragging=!1;camDragLastX=0;camDragLastY=0;_distance=9;_radius=1;_far=200;objectSelected=!1;canvas;constructor(t){this.canvas=t,this._bindEvents()}get distance(){return this._distance}saveRotation(){return this._commitDrag(),[...this.rotation]}loadRotation(t){this.rotation=[...t],this.dragRotation=j(),this.dragStart=null}getObjectRotationMatrix(){return q(k(X(this.dragRotation,this.rotation)))}getViewMatrix(t){const n=this._eyeOffset(),o=[t[0]+n[0],t[1]+n[1],t[2]+n[2]];return x.lookAt(o,t,[0,1,0])}getCamPos(t){const n=this._eyeOffset();return[t[0]+n[0],t[1]+n[1],t[2]+n[2]]}getNearFar(){return[Math.max(.001,this._distance*.01),this._far]}fitCamera(t,n){this._radius=n,this._distance=n*2.5,this._far=n*25,this.camAzimuth=0,this.camElevation=.3}_eyeOffset(){const t=Math.cos(this.camElevation),n=Math.sin(this.camElevation),o=Math.cos(this.camAzimuth),r=Math.sin(this.camAzimuth);return[this._distance*t*r,this._distance*n,this._distance*t*o]}_commitDrag(){this.dragStart&&(this.rotation=k(X(this.dragRotation,this.rotation)),this.dragRotation=j(),this.dragStart=null)}_toNDC(t,n){const o=this.canvas.getBoundingClientRect();return[(t-o.left)/o.width*2-1,-((n-o.top)/o.height)*2+1]}_bindEvents(){this.canvas.addEventListener("mousedown",n=>{if(n.button!==0)return;const[o,r]=this._toNDC(n.clientX,n.clientY),i=K(o,r);this.objectSelected?(this.dragStart=i,this.dragRotation=j()):(this.camDragging=!0,this.camDragLastX=o,this.camDragLastY=r)}),this.canvas.addEventListener("mousemove",n=>{const[o,r]=this._toNDC(n.clientX,n.clientY),i=K(o,r);if(this.objectSelected&&this.dragStart)this.dragRotation=ht(this.dragStart,i);else if(!this.objectSelected&&this.camDragging){const s=o-this.camDragLastX,l=r-this.camDragLastY;this.camAzimuth+=s*Math.PI,this.camElevation=Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,this.camElevation+l*Math.PI)),this.camDragLastX=o,this.camDragLastY=r}});const t=()=>{this.objectSelected&&this.dragStart?(this.rotation=k(X(this.dragRotation,this.rotation)),this.dragRotation=j(),this.dragStart=null):this.objectSelected||(this.camDragging=!1)};this.canvas.addEventListener("mouseup",t),this.canvas.addEventListener("mouseleave",t),this.canvas.addEventListener("wheel",n=>{n.preventDefault(),this._distance*=1+n.deltaY*.001,this._distance=Math.max(this._radius*1.05||.5,this._distance)},{passive:!1})}}if(!navigator.gpu)throw new Error("WebGPU not supported");const I=document.querySelector("#gfx-main");if(!I)throw new Error("Canvas #gfx-main not found");const et=await navigator.gpu.requestAdapter();if(!et)throw new Error("No GPU adapter");const S=await et.requestDevice(),nt=I.getContext("webgpu"),ot=navigator.gpu.getPreferredCanvasFormat();let W=null;function rt(){I.width=Math.max(1,Math.floor(window.innerWidth*devicePixelRatio)),I.height=Math.max(1,Math.floor(window.innerHeight*devicePixelRatio)),nt.configure({device:S,format:ot,alphaMode:"premultiplied"}),W?.destroy(),W=S.createTexture({size:[I.width,I.height],format:"depth24plus",usage:16})}rt();window.addEventListener("resize",rt);const J=352,Q=S.createShaderModule({label:"pipeline",code:mt}),it=S.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:"uniform"}},{binding:1,visibility:2,sampler:{type:"filtering"}},{binding:2,visibility:2,texture:{sampleType:"float"}}]}),gt=S.createRenderPipeline({layout:S.createPipelineLayout({bindGroupLayouts:[it]}),vertex:{module:Q,entryPoint:"vs_main",buffers:[{arrayStride:44,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x3"},{shaderLocation:3,offset:36,format:"float32x2"}]}]},fragment:{module:Q,entryPoint:"fs_main",targets:[{format:ot}]},primitive:{topology:"triangle-list",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"}}),vt=S.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"repeat",addressModeV:"repeat"});function bt(){const e=S.createTexture({size:[1,1],format:"rgba8unorm",usage:6});return S.queue.writeTexture({texture:e},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]),e}function yt(e,t){const n=t.length/3,o=new Float32Array(n*3*11),r=[[1,0,0],[0,1,0],[0,0,1]];for(let i=0;i<n;i++)for(let s=0;s<3;s++){const l=t[i*3+s],c=(i*3+s)*11;o[c]=e[l*8],o[c+1]=e[l*8+1],o[c+2]=e[l*8+2],o[c+3]=e[l*8+3],o[c+4]=e[l*8+4],o[c+5]=e[l*8+5],o[c+6]=r[s][0],o[c+7]=r[s][1],o[c+8]=r[s][2],o[c+9]=e[l*8+6],o[c+10]=e[l*8+7]}return o}function xt(e){const t=S.createBuffer({size:e.byteLength,usage:40});return S.queue.writeBuffer(t,0,e.buffer),t}function st(e,t){const n=[];for(let r=0;r<=e;r++){const i=Math.PI*r/e,s=Math.cos(i),l=Math.sin(i);for(let c=0;c<=t;c++){const d=2*Math.PI*c/t,g=l*Math.cos(d),a=s,u=l*Math.sin(d);n.push(g,a,u,g,a,u,c/t,r/e)}}const o=[];for(let r=0;r<e;r++)for(let i=0;i<t;i++){const s=r*(t+1)+i,l=s+1,c=s+(t+1),d=c+1;o.push(s,c,l,l,c,d)}return{vd:new Float32Array(n),id:new Uint32Array(o)}}function at(){const e=[{n:[0,0,1],v:[[-1,-1,1,0,1],[1,-1,1,1,1],[1,1,1,1,0],[-1,1,1,0,0]]},{n:[0,0,-1],v:[[1,-1,-1,0,1],[-1,-1,-1,1,1],[-1,1,-1,1,0],[1,1,-1,0,0]]},{n:[-1,0,0],v:[[-1,-1,-1,0,1],[-1,-1,1,1,1],[-1,1,1,1,0],[-1,1,-1,0,0]]},{n:[1,0,0],v:[[1,-1,1,0,1],[1,-1,-1,1,1],[1,1,-1,1,0],[1,1,1,0,0]]},{n:[0,1,0],v:[[-1,1,1,0,1],[1,1,1,1,1],[1,1,-1,1,0],[-1,1,-1,0,0]]},{n:[0,-1,0],v:[[-1,-1,-1,0,1],[1,-1,-1,1,1],[1,-1,1,1,0],[-1,-1,1,0,0]]}],t=[],n=[];let o=0;for(const r of e){for(const i of r.v)t.push(i[0],i[1],i[2],...r.n,i[3],i[4]);n.push(o,o+1,o+2,o,o+2,o+3),o+=4}return{vd:new Float32Array(t),id:new Uint32Array(n)}}function tt(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]}function wt(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}function Mt(e){const t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]}function Ct(e){const t=[],n=[],o=[];for(const a of e.split(`
`)){const u=a.trim();if(!u||u.startsWith("#"))continue;const f=u.split(/\s+/);if(f[0]==="v")t.push([parseFloat(f[1]),parseFloat(f[2]),parseFloat(f[3])]);else if(f[0]==="vt")n.push([parseFloat(f[1]),parseFloat(f[2])]);else if(f[0]==="f"){const h=f.slice(1).map(y=>{const b=y.split("/"),_=parseInt(b[0])-1,w=b[1]&&b[1]!==""?parseInt(b[1])-1:null;return[_,w]});for(let y=1;y+1<h.length;y++)o.push([h[0],h[y],h[y+1]])}}const r=t.length,i=o.length,s=n.length>0,l=new Float32Array(r*3),c=new Float32Array(r*3),d=new Float32Array(r*2),g=new Uint32Array(i*3);for(let a=0;a<r;a++)l[a*3]=t[a][0],l[a*3+1]=t[a][1],l[a*3+2]=t[a][2];for(let a=0;a<i;a++){const[[u,f],[h,y],[b,_]]=o[a],w=Mt(wt(tt(t[h],t[u]),tt(t[b],t[u])));for(const M of[u,h,b])c[M*3]+=w[0],c[M*3+1]+=w[1],c[M*3+2]+=w[2];if(g[a*3]=u,g[a*3+1]=h,g[a*3+2]=b,s)for(const[M,m]of[[u,f],[h,y],[b,_]])m!==null&&d[M*2]===0&&d[M*2+1]===0&&(d[M*2]=n[m][0],d[M*2+1]=1-n[m][1])}for(let a=0;a<r;a++){const u=Math.hypot(c[a*3],c[a*3+1],c[a*3+2])||1;c[a*3]/=u,c[a*3+1]/=u,c[a*3+2]/=u}if(!s)for(let a=0;a<r;a++){const u=c[a*3],f=c[a*3+1],h=c[a*3+2];d[a*2]=.5+Math.atan2(h,u)/(2*Math.PI),d[a*2+1]=.5-Math.asin(Math.max(-1,Math.min(1,f)))/Math.PI}return{positions:l,normals:c,uvs:d,indices:g,vertexCount:r,triangleCount:i}}function St(e){const t=new Float32Array(e.vertexCount*8);for(let n=0;n<e.vertexCount;n++)t[n*8]=e.positions[n*3],t[n*8+1]=e.positions[n*3+1],t[n*8+2]=e.positions[n*3+2],t[n*8+3]=e.normals[n*3],t[n*8+4]=e.normals[n*3+1],t[n*8+5]=e.normals[n*3+2],t[n*8+6]=e.uvs[n*2],t[n*8+7]=e.uvs[n*2+1];return{vd:t,id:e.indices}}function _t(e){let t=1/0,n=1/0,o=1/0,r=-1/0,i=-1/0,s=-1/0;for(let a=0;a<e.vertexCount;a++){const u=e.positions[a*3],f=e.positions[a*3+1],h=e.positions[a*3+2];u<t&&(t=u),u>r&&(r=u),f<n&&(n=f),f>i&&(i=f),h<o&&(o=h),h>s&&(s=h)}const l=(t+r)/2,c=(n+i)/2,d=(o+s)/2;let g=0;for(let a=0;a<e.vertexCount;a++){const u=e.positions[a*3]-l,f=e.positions[a*3+1]-c,h=e.positions[a*3+2]-d,y=Math.sqrt(u*u+f*f+h*h);y>g&&(g=y)}return{center:[l,c,d],radius:g}}function zt(){return{tx:0,ty:0,tz:0,rx:0,ry:0,rz:0,sx:1,sy:1,sz:1}}function Et(){return{ambient:.12,diffuse:.75,specular:.55,shininess:48,color:"#4a9eff"}}let Lt=0;class Pt{id=Lt++;label;vertexBuffer;drawCount;uniformBuf;texture;bindGroup;useTexture=0;transform;material;savedRotation=[0,0,0,1];_uab=new ArrayBuffer(J);_uf32=new Float32Array(this._uab);_uu32=new Uint32Array(this._uab);constructor(t,n,o){this.label=t,this.vertexBuffer=n,this.drawCount=o,this.transform=zt(),this.material=Et(),this.texture=bt(),this.uniformBuf=S.createBuffer({size:J,usage:72}),this.bindGroup=this._makeBindGroup()}worldPos(){return[this.transform.tx,this.transform.ty,this.transform.tz]}setTexture(t){this.texture.destroy(),this.texture=t,this.useTexture=1,this.bindGroup=this._makeBindGroup()}buildModel(t){const{tx:n,ty:o,tz:r,rx:i,ry:s,rz:l,sx:c,sy:d,sz:g}=this.transform,a=x.translation(n,o,r),u=x.scaling(c,d,g),f=x.multiply(x.rotationZ(l),x.multiply(x.rotationY(s),x.multiply(x.rotationX(i),t)));return x.multiply(a,x.multiply(f,u))}uploadUniforms(t,n,o,r,i,s,l,c,d){const g=this.buildModel(t),a=x.normalMatrix(g),u=x.multiply(o,x.multiply(n,g)),[f,h,y]=i,b=this.material,[_,w,M]=ct(b.color),m=this._uf32,B=this._uu32;m.set(u,0),m.set(g,16),m.set(a,32),m.set(n,48),m[64]=r[0],m[65]=r[1],m[66]=r[2],m[67]=0,m[68]=f,m[69]=h,m[70]=y,m[71]=0,m[72]=b.ambient,m[73]=b.diffuse,m[74]=b.specular,m[75]=b.shininess,m[76]=s[0],m[77]=s[1],m[78]=s[2],B[79]=l,m[80]=_,m[81]=w,m[82]=M,B[83]=this.useTexture,m[84]=c,B[85]=d?1:0,S.queue.writeBuffer(this.uniformBuf,0,this._uab)}destroy(){this.vertexBuffer.destroy(),this.uniformBuf.destroy(),this.texture.destroy()}_makeBindGroup(){return S.createBindGroup({layout:it,entries:[{binding:0,resource:{buffer:this.uniformBuf}},{binding:1,resource:vt},{binding:2,resource:this.texture.createView()}]})}}function U(e,t,n){return new Pt(e,xt(yt(t,n)),n.length)}async function Bt(e,t){const n=Ct(t),{vd:o,id:r}=St(n),i=U(e,o,r),s=_t(n);return i.transform.tx=-s.center[0],i.transform.ty=-s.center[1],i.transform.tz=-s.center[2],P.fitCamera(s.center,s.radius),i}const v=[];let p=-1;const P=new pt(I);P.objectSelected=!1;const It=[3,6,7];function At(){return p>=0&&v[p]?v[p].worldPos():[0,0,0]}function Y(e){p>=0&&v[p]&&(v[p].savedRotation=P.saveRotation()),p=e,e>=0&&v[e]?(P.objectSelected=!0,P.loadRotation(v[e].savedRotation)):P.objectSelected=!1,ut(),dt()}function Z(e){v.push(e),Y(v.length-1)}function jt(){p<0||v.length===0||(v[p].savedRotation=P.saveRotation(),v[p].destroy(),v.splice(p,1),Y(v.length===0?-1:Math.max(0,p-1)))}const $={renderMode:1,lightColor:"#ffffff"};function ct(e){const t=parseInt(e.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}function z(e,t,n,o,r,i){const s=Number.isInteger(i)?String(i):i.toFixed(2);return`<div class="slider-row">
    <span class="slider-label">${t}</span>
    <input type="range" id="${e}" min="${n}" max="${o}" step="${r}" value="${i}">
    <span class="slider-val" id="${e}-val">${s}</span></div>`}const Rt={0:"Gouraud: lighting per vertex, colour interpolated across face.",1:"Phong: normals interpolated per fragment, lighting per pixel.",2:"Normal buffer: world-space normals encoded as RGB (R=X  G=Y  B=Z).",3:"Wireframe: black edges on white. Hidden surfaces removed by z-buffer.",4:"Depth: linear depth as greyscale -- directly shows z-buffer values.",5:"Texture: spherical-mapped image multiplied by Phong shading.",6:"UV coords: U -> Red,  V -> Green.  Black=(0,0)  Yellow=(1,1)."},H=document.createElement("div");H.id="gui";H.innerHTML=`
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
    ${z("tr-tx","Translate X",-12,12,.05,0)}
    ${z("tr-ty","Translate Y",-12,12,.05,0)}
    ${z("tr-tz","Translate Z",-12,12,.05,0)}
    ${z("tr-rx","Rotate X",-3.15,3.15,.01,0)}
    ${z("tr-ry","Rotate Y",-3.15,3.15,.01,0)}
    ${z("tr-rz","Rotate Z",-3.15,3.15,.01,0)}
    ${z("tr-sx","Scale X",.05,6,.05,1)}
    ${z("tr-sy","Scale Y",.05,6,.05,1)}
    ${z("tr-sz","Scale Z",.05,6,.05,1)}
    <div class="gui-label">Material</div>
    ${z("mt-ambient","Ambient (Ka)",0,1,.01,.12)}
    ${z("mt-diffuse","Diffuse (Kd)",0,1,.01,.75)}
    ${z("mt-specular","Specular (Ks)",0,1,.01,.55)}
    ${z("mt-shine","Shininess (n)",1,256,1,48)}
    <div class="color-row" style="margin-top:4px">
      <span>Object color</span><input type="color" id="mt-color" value="#4a9eff">
    </div>
    <div class="gui-label">Texture (spherical UV)</div>
    <input type="file" id="tex-upload" accept="image/*" class="file-input">
    <label class="checkbox-row"><input type="checkbox" id="use-texture"> Use texture</label>
  </div>
</div>`;document.body.appendChild(H);function lt(){document.getElementById("mode-desc").textContent=Rt[$.renderMode]}lt();document.querySelectorAll(".mode-btn").forEach(e=>{e.addEventListener("click",()=>{$.renderMode=Number(e.dataset.id),document.querySelectorAll(".mode-btn").forEach(t=>t.classList.remove("active")),e.classList.add("active"),lt()})});document.getElementById("add-sphere").addEventListener("click",()=>{const{vd:e,id:t}=st(64,64);Z(U("Sphere",e,t))});document.getElementById("add-cube").addEventListener("click",()=>{const{vd:e,id:t}=at();Z(U("Cube",e,t))});document.getElementById("obj-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];t&&Z(await Bt(t.name.replace(".obj",""),await t.text()))});document.getElementById("btn-deselect").addEventListener("click",()=>Y(-1));document.getElementById("btn-remove").addEventListener("click",jt);document.getElementById("g-lightColor").addEventListener("input",e=>{$.lightColor=e.target.value});function ut(){const e=document.getElementById("object-list");e.innerHTML="",v.forEach((t,n)=>{const o=document.createElement("button");o.className="obj-list-btn"+(n===p?" active":""),o.textContent=`${n+1}. ${t.label}`,o.addEventListener("click",()=>Y(n===p?-1:n)),e.appendChild(o)})}function E(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&(n.value=String(t)),o&&(o.textContent=Number.isInteger(t)?String(t):t.toFixed(2))}function dt(){const e=document.getElementById("inspector-title");if(p<0||!v[p]){e.textContent="No selection — camera orbit mode";return}const t=v[p];e.textContent=t.label;const n=t.transform;E("tr-tx",n.tx),E("tr-ty",n.ty),E("tr-tz",n.tz),E("tr-rx",n.rx),E("tr-ry",n.ry),E("tr-rz",n.rz),E("tr-sx",n.sx),E("tr-sy",n.sy),E("tr-sz",n.sz);const o=t.material;E("mt-ambient",o.ambient),E("mt-diffuse",o.diffuse),E("mt-specular",o.specular),E("mt-shine",o.shininess),document.getElementById("mt-color").value=o.color,document.getElementById("use-texture").checked=t.useTexture===1}function L(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&n.addEventListener("input",()=>{const r=parseFloat(n.value);o&&(o.textContent=Number.isInteger(r)?String(r):r.toFixed(2)),p>=0&&v[p]&&t(v[p],r)})}L("tr-tx",(e,t)=>{e.transform.tx=t});L("tr-ty",(e,t)=>{e.transform.ty=t});L("tr-tz",(e,t)=>{e.transform.tz=t});L("tr-rx",(e,t)=>{e.transform.rx=t});L("tr-ry",(e,t)=>{e.transform.ry=t});L("tr-rz",(e,t)=>{e.transform.rz=t});L("tr-sx",(e,t)=>{e.transform.sx=t});L("tr-sy",(e,t)=>{e.transform.sy=t});L("tr-sz",(e,t)=>{e.transform.sz=t});L("mt-ambient",(e,t)=>{e.material.ambient=t});L("mt-diffuse",(e,t)=>{e.material.diffuse=t});L("mt-specular",(e,t)=>{e.material.specular=t});L("mt-shine",(e,t)=>{e.material.shininess=t});document.getElementById("mt-color").addEventListener("input",e=>{p>=0&&v[p]&&(v[p].material.color=e.target.value)});document.getElementById("tex-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];if(!t||p<0||!v[p])return;const n=await createImageBitmap(t,{colorSpaceConversion:"none"}),o=S.createTexture({size:[n.width,n.height],format:"rgba8unorm",usage:22});S.queue.copyExternalImageToTexture({source:n},{texture:o},[n.width,n.height]),v[p].setTexture(o),document.getElementById("use-texture").checked=!0});document.getElementById("use-texture").addEventListener("change",e=>{p>=0&&v[p]&&(v[p].useTexture=e.target.checked?1:0)});{const{vd:e,id:t}=st(64,64),n=U("Sphere",e,t);n.transform.tx=-2.5,v.push(n)}{const{vd:e,id:t}=at(),n=U("Cube",e,t);n.transform.tx=2.5,v.push(n)}p=-1;P.objectSelected=!1;ut();dt();const Nt=performance.now();function ft(e){const t=(e-Nt)/1e3,n=I.width/I.height,[o,r]=P.getNearFar(),i=x.perspective(60*Math.PI/180,n,o,r),[s,l,c]=ct($.lightColor),d=[s,l,c],g=At(),a=P.getViewMatrix(g),u=P.getCamPos(g),f=q([0,0,0,1]),h=p>=0&&v[p]?P.getObjectRotationMatrix():f,y=S.createCommandEncoder(),b=y.beginRenderPass({colorAttachments:[{view:nt.getCurrentTexture().createView(),clearValue:{r:.08,g:.08,b:.12,a:1},loadOp:"clear",storeOp:"store"}],depthStencilAttachment:{view:W.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"store"}});b.setPipeline(gt);for(let _=0;_<v.length;_++){const w=v[_],M=_===p,m=M?h:q(w.savedRotation);w.uploadUniforms(m,a,i,It,d,u,$.renderMode,t,M),b.setBindGroup(0,w.bindGroup),b.setVertexBuffer(0,w.vertexBuffer),b.draw(w.drawCount)}b.end(),S.queue.submit([y.finish()]),requestAnimationFrame(ft)}requestAnimationFrame(ft);
