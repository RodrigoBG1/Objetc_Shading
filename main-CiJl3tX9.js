import{m as w}from"./math-hklpcMvZ.js";const ut=`// =============================================================================
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

  let wp4 = u.model    * vec4<f32>(in.position, 1.0);
  let wn4 = u.normalMat * vec4<f32>(in.normal, 0.0);

  out.clipPos     = u.mvp * vec4<f32>(in.position, 1.0);
  out.worldPos    = wp4.xyz;
  out.worldNormal = normalize(wn4.xyz);
  out.barycentric = in.barycentric;
  out.uv          = in.uv;
  out.depth       = out.clipPos.z / out.clipPos.w;

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

  var baseColor = u.objectColor;
  if u.use_texture == 1u {
    baseColor = baseColor * textureSample(tex_img, tex_samp, in.uv).rgb;
  }

  var color: vec3<f32>;

  switch u.render_mode {

    // Gouraud
    case 0u: {
      color = in.gouraudColor;
      if u.use_texture == 1u {
        color = color * textureSample(tex_img, tex_samp, in.uv).rgb;
      }
    }

    // Phong
    case 1u: {
      color = phongLight(N, in.worldPos, baseColor);
    }

    // Normal buffer  (N remapped [-1,1] -> [0,1])
    case 2u: {
      color = N * 0.5 + vec3<f32>(0.5);
    }

    // Wireframe -- black & white only
    case 3u: {
      let edge = min(in.barycentric.x, min(in.barycentric.y, in.barycentric.z));
      let wire = 1.0 - smoothstep(0.0, 0.018, edge);
      let grey = 1.0 - wire;   // white fill, black edge
      color = vec3<f32>(grey);
    }

    // Depth
    case 4u: {
      let d = (in.depth + 1.0) * 0.5;
      color = vec3<f32>(d);
    }

    // Texture x Phong
    case 5u: {
      let tc = textureSample(tex_img, tex_samp, in.uv).rgb;
      color = phongLight(N, in.worldPos, tc);
    }

    // UV coordinates as colour  (black=0,0  red=1,0  green=0,1  yellow=1,1)
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
`;function k(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]}function dt(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}function ft(e){const t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]}function mt(e){const t=[],n=[],o=[];for(const a of e.split(`
`)){const u=a.trim();if(!u||u.startsWith("#"))continue;const d=u.split(/\s+/);if(d[0]==="v")t.push([parseFloat(d[1]),parseFloat(d[2]),parseFloat(d[3])]);else if(d[0]==="vt")n.push([parseFloat(d[1]),parseFloat(d[2])]);else if(d[0]==="f"){const b=d.slice(1).map(y=>{const C=y.split("/"),I=parseInt(C[0])-1,L=C[1]&&C[1]!==""?parseInt(C[1])-1:null;return[I,L]});for(let y=1;y+1<b.length;y++)o.push([b[0],b[y],b[y+1]])}}const i=t.length,r=o.length,c=n.length>0,l=new Float32Array(i*3),s=new Float32Array(i*3),m=new Float32Array(i*2),v=new Uint32Array(r*3),p=new Float32Array(r*3);for(let a=0;a<i;a++)l[a*3+0]=t[a][0],l[a*3+1]=t[a][1],l[a*3+2]=t[a][2];for(let a=0;a<r;a++){const[[u,d],[b,y],[C,I]]=o[a],L=t[u],g=t[b],R=t[C],B=ft(dt(k(g,L),k(R,L)));p[a*3+0]=B[0],p[a*3+1]=B[1],p[a*3+2]=B[2];for(const z of[u,b,C])s[z*3+0]+=B[0],s[z*3+1]+=B[1],s[z*3+2]+=B[2];if(v[a*3+0]=u,v[a*3+1]=b,v[a*3+2]=C,c)for(const[z,D]of[[u,d],[b,y],[C,I]])D!==null&&m[z*2]===0&&m[z*2+1]===0&&(m[z*2+0]=n[D][0],m[z*2+1]=1-n[D][1])}for(let a=0;a<i;a++){const u=Math.hypot(s[a*3],s[a*3+1],s[a*3+2])||1;s[a*3+0]/=u,s[a*3+1]/=u,s[a*3+2]/=u}if(!c)for(let a=0;a<i;a++){const u=s[a*3+0],d=s[a*3+1],b=s[a*3+2];m[a*2+0]=.5+Math.atan2(b,u)/(2*Math.PI),m[a*2+1]=.5-Math.asin(Math.max(-1,Math.min(1,d)))/Math.PI}return{positions:l,normals:s,uvs:m,indices:v,faceNormals:p,vertexCount:i,triangleCount:r}}function ht(e){const t=new Float32Array(e.vertexCount*8);for(let n=0;n<e.vertexCount;n++)t[n*8+0]=e.positions[n*3+0],t[n*8+1]=e.positions[n*3+1],t[n*8+2]=e.positions[n*3+2],t[n*8+3]=e.normals[n*3+0],t[n*8+4]=e.normals[n*3+1],t[n*8+5]=e.normals[n*3+2],t[n*8+6]=e.uvs[n*2+0],t[n*8+7]=e.uvs[n*2+1];return{vertexData:t,indexData:e.indices}}function pt(e){let t=1/0,n=1/0,o=1/0,i=-1/0,r=-1/0,c=-1/0;for(let p=0;p<e.vertexCount;p++){const a=e.positions[p*3+0],u=e.positions[p*3+1],d=e.positions[p*3+2];a<t&&(t=a),a>i&&(i=a),u<n&&(n=u),u>r&&(r=u),d<o&&(o=d),d>c&&(c=d)}const l=(t+i)/2,s=(n+r)/2,m=(o+c)/2;let v=0;for(let p=0;p<e.vertexCount;p++){const a=e.positions[p*3+0]-l,u=e.positions[p*3+1]-s,d=e.positions[p*3+2]-m,b=Math.sqrt(a*a+u*u+d*d);b>v&&(v=b)}return{center:[l,s,m],radius:v}}function P(){return[0,0,0,1]}function F(e,t){const[n,o,i,r]=e,[c,l,s,m]=t;return[r*c+n*m+o*s-i*l,r*l-n*s+o*m+i*c,r*s+n*l-o*c+i*m,r*m-n*c-o*l-i*s]}function N(e){const t=Math.hypot(e[0],e[1],e[2],e[3])||1;return[e[0]/t,e[1]/t,e[2]/t,e[3]/t]}function O(e){const[t,n,o,i]=e,r=new Float32Array(16);return r[0]=1-2*(n*n+o*o),r[4]=2*(t*n-o*i),r[8]=2*(t*o+n*i),r[12]=0,r[1]=2*(t*n+o*i),r[5]=1-2*(t*t+o*o),r[9]=2*(n*o-t*i),r[13]=0,r[2]=2*(t*o-n*i),r[6]=2*(n*o+t*i),r[10]=1-2*(t*t+n*n),r[14]=0,r[3]=0,r[7]=0,r[11]=0,r[15]=1,r}function Y(e,t){const n=e*e+t*t;if(n<=1)return[e,t,Math.sqrt(1-n)];const o=Math.sqrt(n);return[e/o,t/o,0]}class gt{canvas;rotation=P();dragRotation=P();dragStart=null;camAzimuth=0;camElevation=.3;camDragging=!1;camDragLastX=0;camDragLastY=0;_distance=9;objectSelected=!1;constructor(t){this.canvas=t,this._bindEvents()}saveRotation(){return this._commitDrag(),[...this.rotation]}loadRotation(t){this.rotation=[...t],this.dragRotation=P(),this.dragStart=null}getObjectRotationMatrix(){const t=N(F(this.dragRotation,this.rotation));return O(t)}get distance(){return this._distance}getViewMatrix(t){const n=this._eyeOffset(),o=[t[0]+n[0],t[1]+n[1],t[2]+n[2]];return w.lookAt(o,t,[0,1,0])}getCamPos(t){const n=this._eyeOffset();return[t[0]+n[0],t[1]+n[1],t[2]+n[2]]}_eyeOffset(){const t=Math.cos(this.camElevation),n=Math.sin(this.camElevation),o=Math.cos(this.camAzimuth),i=Math.sin(this.camAzimuth);return[this._distance*t*i,this._distance*n,this._distance*t*o]}_commitDrag(){this.dragStart&&(this.rotation=N(F(this.dragRotation,this.rotation)),this.dragRotation=P(),this.dragStart=null)}_toNDC(t,n){const o=this.canvas.getBoundingClientRect();return[(t-o.left)/o.width*2-1,-((n-o.top)/o.height)*2+1]}_bindEvents(){this.canvas.addEventListener("mousedown",n=>{if(n.button!==0)return;const[o,i]=this._toNDC(n.clientX,n.clientY),r=Y(o,i);this.objectSelected?(this.dragStart=r,this.dragRotation=P()):(this.camDragging=!0,this.camDragLastX=o,this.camDragLastY=i)}),this.canvas.addEventListener("mousemove",n=>{const[o,i]=this._toNDC(n.clientX,n.clientY),r=Y(o,i);if(this.objectSelected&&this.dragStart)this.dragRotation=bt(this.dragStart,r);else if(!this.objectSelected&&this.camDragging){const c=o-this.camDragLastX,l=i-this.camDragLastY;this.camAzimuth+=c*Math.PI,this.camElevation=Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,this.camElevation+l*Math.PI)),this.camDragLastX=o,this.camDragLastY=i}});const t=()=>{this.objectSelected&&this.dragStart?(this.rotation=N(F(this.dragRotation,this.rotation)),this.dragRotation=P(),this.dragStart=null):this.objectSelected||(this.camDragging=!1)};this.canvas.addEventListener("mouseup",t),this.canvas.addEventListener("mouseleave",t),this.canvas.addEventListener("wheel",n=>{n.preventDefault(),this._distance*=1+n.deltaY*.001,this._distance=Math.max(.5,this._distance)},{passive:!1})}}function bt(e,t){const[n,o,i]=e,[r,c,l]=t,s=Math.min(1,n*r+o*c+i*l),m=Math.acos(s);if(m<1e-6)return P();const v=o*l-i*c,p=i*r-n*l,a=n*c-o*r,u=Math.hypot(v,p,a);if(u<1e-10)return P();const d=m*.5,b=Math.sin(d)/u;return N([v*b,p*b,a*b,Math.cos(d)])}if(!navigator.gpu)throw new Error("WebGPU not supported");const _=document.querySelector("#gfx-main");if(!_)throw new Error("Canvas #gfx-main not found");const W=await navigator.gpu.requestAdapter();if(!W)throw new Error("No GPU adapter");const x=await W.requestDevice(),H=_.getContext("webgpu"),Z=navigator.gpu.getPreferredCanvasFormat();let V=null;function K(){_.width=Math.max(1,Math.floor(window.innerWidth*devicePixelRatio)),_.height=Math.max(1,Math.floor(window.innerHeight*devicePixelRatio)),H.configure({device:x,format:Z,alphaMode:"premultiplied"}),V?.destroy(),V=x.createTexture({size:[_.width,_.height],format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT})}K();window.addEventListener("resize",K);const X=352,q=x.createShaderModule({label:"pipeline",code:ut}),J=x.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float"}}]}),vt=x.createRenderPipeline({layout:x.createPipelineLayout({bindGroupLayouts:[J]}),vertex:{module:q,entryPoint:"vs_main",buffers:[{arrayStride:44,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x3"},{shaderLocation:3,offset:36,format:"float32x2"}]}]},fragment:{module:q,entryPoint:"fs_main",targets:[{format:Z}]},primitive:{topology:"triangle-list",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"}}),xt=x.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"repeat",addressModeV:"repeat"});function yt(){const e=x.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});return x.queue.writeTexture({texture:e},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]),e}function wt(){return{tx:0,ty:0,tz:0,rx:0,ry:0,rz:0,sx:1,sy:1,sz:1}}function St(){return{ambient:.12,diffuse:.75,specular:.55,shininess:48,color:"#4a9eff"}}let Et=0;class Q{id=Et++;label;vertexBuffer;drawCount;uniformBuf;texture;bindGroup;useTexture=0;transform;material;savedRotation=P();_uab=new ArrayBuffer(X);_uf32=new Float32Array(this._uab);_uu32=new Uint32Array(this._uab);constructor(t,n,o){this.label=t,this.vertexBuffer=n,this.drawCount=o,this.transform=wt(),this.material=St(),this.texture=yt(),this.uniformBuf=x.createBuffer({size:X,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.bindGroup=this._bg()}_bg(){return x.createBindGroup({layout:J,entries:[{binding:0,resource:{buffer:this.uniformBuf}},{binding:1,resource:xt},{binding:2,resource:this.texture.createView()}]})}setTexture(t){this.texture.destroy(),this.texture=t,this.useTexture=1,this.bindGroup=this._bg()}worldPos(){return[this.transform.tx,this.transform.ty,this.transform.tz]}buildModel(t){const{tx:n,ty:o,tz:i,rx:r,ry:c,rz:l,sx:s,sy:m,sz:v}=this.transform,p=w.translation(n,o,i),a=w.scaling(s,m,v),u=w.multiply(w.rotationZ(l),w.multiply(w.rotationY(c),w.multiply(w.rotationX(r),t)));return w.multiply(p,w.multiply(u,a))}uploadUniforms(t,n,o,i,r,c,l,s,m){const v=this.buildModel(t),p=w.normalMatrix(v),a=w.multiply(o,w.multiply(n,v)),[u,d,b]=r,y=this.material,[C,I,L]=it(y.color),g=this._uf32,R=this._uu32;g.set(a,0),g.set(v,16),g.set(p,32),g.set(n,48),g[64]=i[0],g[65]=i[1],g[66]=i[2],g[67]=0,g[68]=u,g[69]=d,g[70]=b,g[71]=0,g[72]=y.ambient,g[73]=y.diffuse,g[74]=y.specular,g[75]=y.shininess,g[76]=c[0],g[77]=c[1],g[78]=c[2],R[79]=l,g[80]=C,g[81]=I,g[82]=L,R[83]=this.useTexture,g[84]=s,R[85]=m?1:0,x.queue.writeBuffer(this.uniformBuf,0,this._uab)}destroy(){this.vertexBuffer.destroy(),this.uniformBuf.destroy(),this.texture.destroy()}}function tt(e,t){const n=t.length/3,o=new Float32Array(n*3*11),i=[[1,0,0],[0,1,0],[0,0,1]];for(let r=0;r<n;r++)for(let c=0;c<3;c++){const l=t[r*3+c],s=(r*3+c)*11;o[s]=e[l*8],o[s+1]=e[l*8+1],o[s+2]=e[l*8+2],o[s+3]=e[l*8+3],o[s+4]=e[l*8+4],o[s+5]=e[l*8+5],o[s+6]=i[c][0],o[s+7]=i[c][1],o[s+8]=i[c][2],o[s+9]=e[l*8+6],o[s+10]=e[l*8+7]}return o}function et(e){const t=x.createBuffer({size:e.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});return x.queue.writeBuffer(t,0,e.buffer),t}function nt(e,t){const n=[];for(let i=0;i<=e;i++){const r=Math.PI*i/e,c=Math.cos(r),l=Math.sin(r);for(let s=0;s<=t;s++){const m=2*Math.PI*s/t,v=Math.cos(m),p=Math.sin(m),a=l*v,u=c,d=l*p;n.push(a,u,d,a,u,d,s/t,i/e)}}const o=[];for(let i=0;i<e;i++)for(let r=0;r<t;r++){const c=i*(t+1)+r,l=c+1,s=c+(t+1),m=s+1;o.push(c,s,l,l,s,m)}return{vd:new Float32Array(n),id:new Uint32Array(o)}}function ot(){const e=[{n:[0,0,1],v:[[-1,-1,1,0,1],[1,-1,1,1,1],[1,1,1,1,0],[-1,1,1,0,0]]},{n:[0,0,-1],v:[[1,-1,-1,0,1],[-1,-1,-1,1,1],[-1,1,-1,1,0],[1,1,-1,0,0]]},{n:[-1,0,0],v:[[-1,-1,-1,0,1],[-1,-1,1,1,1],[-1,1,1,1,0],[-1,1,-1,0,0]]},{n:[1,0,0],v:[[1,-1,1,0,1],[1,-1,-1,1,1],[1,1,-1,1,0],[1,1,1,0,0]]},{n:[0,1,0],v:[[-1,1,1,0,1],[1,1,1,1,1],[1,1,-1,1,0],[-1,1,-1,0,0]]},{n:[0,-1,0],v:[[-1,-1,-1,0,1],[1,-1,-1,1,1],[1,-1,1,1,0],[-1,-1,1,0,0]]}],t=[],n=[];let o=0;for(const i of e){for(const r of i.v)t.push(r[0],r[1],r[2],...i.n,r[3],r[4]);n.push(o,o+1,o+2,o,o+2,o+3),o+=4}return{vd:new Float32Array(t),id:new Uint32Array(n)}}function G(e,t,n){return new Q(e,et(tt(t,n)),n.length)}async function rt(e,t){const n=mt(t),{vertexData:o,indexData:i}=ht(n),r=new Q(e,et(tt(o,i)),i.length),c=pt(n);return r.transform.tx=-c.center[0],r.transform.ty=-c.center[1],r.transform.tz=-c.center[2],r}const h=[];let f=-1;const T=new gt(_);T.objectSelected=!1;function Mt(){return f>=0&&h[f]?h[f].worldPos():[0,0,0]}function U(e){f>=0&&h[f]&&(h[f].savedRotation=T.saveRotation()),f=e,e>=0&&h[e]?(T.objectSelected=!0,T.loadRotation(h[e].savedRotation)):T.objectSelected=!1,at(),st()}function A(e){h.push(e),U(h.length-1)}function Ct(){if(!(f<0||h.length===0)){if(h[f].savedRotation=T.saveRotation(),h[f].destroy(),h.splice(f,1),h.length===0){U(-1);return}U(Math.max(0,f-1))}}function Pt(){U(-1)}_.addEventListener("click",e=>{e._dragged});const j={renderMode:1,lightColor:"#ffffff"};function it(e){const t=parseInt(e.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}function S(e,t,n,o,i,r){const c=Number.isInteger(r)?String(r):r.toFixed(2);return`<div class="slider-row">
    <span class="slider-label">${t}</span>
    <input type="range" id="${e}" min="${n}" max="${o}" step="${i}" value="${r}">
    <span class="slider-val" id="${e}-val">${c}</span></div>`}const _t={0:"Gouraud: lighting per vertex, colour interpolated across face.",1:"Phong: normals interpolated per fragment, lighting per pixel.",2:"Normal buffer: world-space normals encoded as RGB (R=X  G=Y  B=Z).",3:"Wireframe: black edges on white. Hidden surfaces removed by z-buffer.",4:"Depth: linear depth as greyscale -- directly shows z-buffer values.",5:"Texture: spherical-mapped image multiplied by Phong shading.",6:"UV coords: U -> Red,  V -> Green.  Black=(0,0)  Yellow=(1,1)."},$=document.createElement("div");$.id="gui";$.innerHTML=`
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
  <div class="gui-hint">No selection: drag orbits camera<br>Object selected: drag rotates object<br>Scroll: zoom toward target</div>
</div>

<div class="gui-panel" id="panel-right">
  <div class="gui-title">Scene</div>
  <div id="object-list"></div>
  <div class="btn-row" style="margin-top:6px">
    <button id="btn-deselect">Deselect</button>
    <button id="btn-remove">Remove</button>
  </div>
  <div id="inspector" style="margin-top:10px">
    <div class="inspector-sub-label" id="inspector-title">No selection -- camera orbit mode</div>
    <div class="inspector-sub-label">Transform</div>
    ${S("tr-tx","Translate X",-12,12,.05,0)}
    ${S("tr-ty","Translate Y",-12,12,.05,0)}
    ${S("tr-tz","Translate Z",-12,12,.05,0)}
    ${S("tr-rx","Rotate X",-3.15,3.15,.01,0)}
    ${S("tr-ry","Rotate Y",-3.15,3.15,.01,0)}
    ${S("tr-rz","Rotate Z",-3.15,3.15,.01,0)}
    ${S("tr-sx","Scale X",.05,6,.05,1)}
    ${S("tr-sy","Scale Y",.05,6,.05,1)}
    ${S("tr-sz","Scale Z",.05,6,.05,1)}
    <div class="inspector-sub-label">Material</div>
    ${S("mt-ambient","Ambient (Ka)",0,1,.01,.12)}
    ${S("mt-diffuse","Diffuse (Kd)",0,1,.01,.75)}
    ${S("mt-specular","Specular (Ks)",0,1,.01,.55)}
    ${S("mt-shine","Shininess (n)",1,256,1,48)}
    <div class="color-row" style="margin-top:4px">
      <span>Object color</span><input type="color" id="mt-color" value="#4a9eff">
    </div>
    <div class="inspector-sub-label">Texture (spherical UV)</div>
    <input type="file" id="tex-upload" accept="image/*" class="file-input">
    <label class="checkbox-row"><input type="checkbox" id="use-texture"> Use texture</label>
  </div>
</div>`;document.body.appendChild($);function at(){const e=document.getElementById("object-list");e.innerHTML="",h.forEach((t,n)=>{const o=document.createElement("button");o.className="obj-list-btn"+(n===f?" active":""),o.textContent=`${n+1}. ${t.label}`,o.addEventListener("click",()=>U(n===f?-1:n)),e.appendChild(o)})}function E(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&(n.value=String(t),o&&(o.textContent=Number.isInteger(t)?String(t):t.toFixed(2)))}function st(){const e=document.getElementById("inspector-title");if(f<0||!h[f]){e.textContent="No selection -- camera orbit mode";return}const t=h[f];e.textContent=t.label;const n=t.transform;E("tr-tx",n.tx),E("tr-ty",n.ty),E("tr-tz",n.tz),E("tr-rx",n.rx),E("tr-ry",n.ry),E("tr-rz",n.rz),E("tr-sx",n.sx),E("tr-sy",n.sy),E("tr-sz",n.sz);const o=t.material;E("mt-ambient",o.ambient),E("mt-diffuse",o.diffuse),E("mt-specular",o.specular),E("mt-shine",o.shininess),document.getElementById("mt-color").value=o.color,document.getElementById("use-texture").checked=t.useTexture===1}function ct(){document.getElementById("mode-desc").textContent=_t[j.renderMode]}ct();document.querySelectorAll(".mode-btn").forEach(e=>{e.addEventListener("click",()=>{j.renderMode=Number(e.dataset.id),document.querySelectorAll(".mode-btn").forEach(t=>t.classList.remove("active")),e.classList.add("active"),ct()})});document.getElementById("add-sphere").addEventListener("click",()=>{const{vd:e,id:t}=nt(64,64);A(G("Sphere",e,t))});document.getElementById("add-cube").addEventListener("click",()=>{const{vd:e,id:t}=ot();A(G("Cube",e,t))});document.querySelectorAll(".add-obj-btn").forEach(e=>{e.addEventListener("click",async()=>{const t=e.dataset.obj;try{const n=await fetch(`/models/${t}`);if(!n.ok)throw new Error(n.statusText);A(await rt(t.replace(".obj",""),await n.text()))}catch{alert(`Could not load ${t} -- place it in public/models/`)}})});document.getElementById("obj-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];t&&A(await rt(t.name.replace(".obj",""),await t.text()))});document.getElementById("btn-remove").addEventListener("click",Ct);document.getElementById("btn-deselect").addEventListener("click",Pt);function M(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&n.addEventListener("input",()=>{const i=parseFloat(n.value);o&&(o.textContent=Number.isInteger(i)?String(i):i.toFixed(2)),f>=0&&h[f]&&t(h[f],i)})}M("tr-tx",(e,t)=>e.transform.tx=t);M("tr-ty",(e,t)=>e.transform.ty=t);M("tr-tz",(e,t)=>e.transform.tz=t);M("tr-rx",(e,t)=>e.transform.rx=t);M("tr-ry",(e,t)=>e.transform.ry=t);M("tr-rz",(e,t)=>e.transform.rz=t);M("tr-sx",(e,t)=>e.transform.sx=t);M("tr-sy",(e,t)=>e.transform.sy=t);M("tr-sz",(e,t)=>e.transform.sz=t);M("mt-ambient",(e,t)=>e.material.ambient=t);M("mt-diffuse",(e,t)=>e.material.diffuse=t);M("mt-specular",(e,t)=>e.material.specular=t);M("mt-shine",(e,t)=>e.material.shininess=t);document.getElementById("mt-color").addEventListener("input",e=>{f>=0&&h[f]&&(h[f].material.color=e.target.value)});document.getElementById("g-lightColor").addEventListener("input",e=>{j.lightColor=e.target.value});document.getElementById("tex-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];if(!t||f<0||!h[f])return;const n=await createImageBitmap(t,{colorSpaceConversion:"none"}),o=x.createTexture({size:[n.width,n.height],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});x.queue.copyExternalImageToTexture({source:n},{texture:o},[n.width,n.height]),h[f].setTexture(o),document.getElementById("use-texture").checked=!0});document.getElementById("use-texture").addEventListener("change",e=>{f>=0&&h[f]&&(h[f].useTexture=e.target.checked?1:0)});{const{vd:e,id:t}=nt(64,64),n=G("Sphere",e,t);n.transform.tx=-2.5,h.push(n)}{const{vd:e,id:t}=ot(),n=G("Cube",e,t);n.transform.tx=2.5,h.push(n)}f=-1;T.objectSelected=!1;at();st();const Tt=performance.now(),zt=[3,6,7];function lt(e){const t=(e-Tt)/1e3,n=_.width/_.height,o=w.perspective(60*Math.PI/180,n,.05,300),[i,r,c]=it(j.lightColor),l=Mt(),s=T.getViewMatrix(l),m=T.getCamPos(l),v=f>=0&&h[f]?T.getObjectRotationMatrix():O(P()),p=x.createCommandEncoder(),a=p.beginRenderPass({colorAttachments:[{view:H.getCurrentTexture().createView(),clearValue:{r:.08,g:.08,b:.12,a:1},loadOp:"clear",storeOp:"store"}],depthStencilAttachment:{view:V.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"store"}});a.setPipeline(vt);for(let u=0;u<h.length;u++){const d=h[u],b=u===f,y=b?v:O(d.savedRotation);d.uploadUniforms(y,s,o,zt,[i,r,c],m,j.renderMode,t,b),a.setBindGroup(0,d.bindGroup),a.setVertexBuffer(0,d.vertexBuffer),a.draw(d.drawCount)}a.end(),x.queue.submit([p.finish()]),requestAnimationFrame(lt)}requestAnimationFrame(lt);
