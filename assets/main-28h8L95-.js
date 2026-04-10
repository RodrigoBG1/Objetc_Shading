(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))o(r);new MutationObserver(r=>{for(const a of r)if(a.type==="childList")for(const i of a.addedNodes)i.tagName==="LINK"&&i.rel==="modulepreload"&&o(i)}).observe(document,{childList:!0,subtree:!0});function n(r){const a={};return r.integrity&&(a.integrity=r.integrity),r.referrerPolicy&&(a.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?a.credentials="include":r.crossOrigin==="anonymous"?a.credentials="omit":a.credentials="same-origin",a}function o(r){if(r.ep)return;r.ep=!0;const a=n(r);fetch(r.href,a)}})();const mt=`// todos los datos que le mando desde el CPU a cada objeto
// tienen que estar en el mismo orden que en el TypeScript
struct PerObjectUBO {
  mvpMatrix    : mat4x4<f32>,  // model * view * projection junta todo
  worldMatrix  : mat4x4<f32>,  // solo mueve el objeto al mundo
  normalMatrix : mat4x4<f32>,  // es la transpuesta de la inversa del worldMatrix, para transformar normales bien
  viewMatrix   : mat4x4<f32>,  // donde esta la camara

  lightPosition : vec3<f32>,
  _pad0         : f32,         // relleno porque los vec3 necesitan estar alineados a 16 bytes

  lightTint     : vec3<f32>,   // color de la luz (rgb)
  _pad1         : f32,

  Ka         : f32,   // coeficiente ambiental
  Kd         : f32,   // coeficiente difuso
  Ks         : f32,   // coeficiente especular
  shininess  : f32,   // que tan brilloso es, entre mas alto mas pequeno el brillo

  eyePosition  : vec3<f32>,   // posicion de la camara en el mundo
  shadingMode  : u32,          // 0=gouraud 1=phong 2=normales 3=wireframe 4=depth 5=textura 6=uv

  albedoColor  : vec3<f32>,   // color base del objeto
  texEnabled   : u32,          // si es 1 usa textura, si es 0 no

  elapsed      : f32,          // tiempo en segundos desde que empezo
  highlighted  : u32,          // 1 si el objeto esta seleccionado
  _pad2        : f32,
  _pad3        : f32,
};

// binding 0 = uniforms, 1 = sampler, 2 = textura
@group(0) @binding(0) var<uniform> ubo       : PerObjectUBO;
@group(0) @binding(1) var          smp       : sampler;
@group(0) @binding(2) var          albedoTex : texture_2d<f32>;

// lo que le entra al vertex shader desde el buffer de vertices
// stride de 44 bytes: pos(12) + nrm(12) + bary(12) + uv(8)
struct VertIn {
  @location(0) pos  : vec3<f32>,  // posicion xyz
  @location(1) nrm  : vec3<f32>,  // normal xyz
  @location(2) bary : vec3<f32>,  // coordenadas baricentricas del triangulo
  @location(3) uv   : vec2<f32>,  // coordenadas de textura
};

// lo que sale del vertex shader y llega interpolado al fragment shader
struct VertOut {
  @builtin(position) clip : vec4<f32>,  // posicion en clip space, obligatoria
  @location(0) wPos       : vec3<f32>,  // posicion en espacio mundo
  @location(1) wNrm       : vec3<f32>,  // normal en espacio mundo
  @location(2) bary       : vec3<f32>,  // baricentricas (para wireframe)
  @location(3) texCoord   : vec2<f32>,  // uv para muestrear textura
  @location(4) gouraud    : vec3<f32>,  // color calculado en el vertex (solo modo gouraud)
  @location(5) ndcDepth   : f32,        // profundidad normalizada para el modo depth
};

// calcula la iluminacion Blinn-Phong para un punto de la superficie
// uso el half-vector en vez del vector de reflexion porque es mas barato y se ve mejor
fn blinnPhong(surfNormal: vec3<f32>, fragPos: vec3<f32>, surfColor: vec3<f32>) -> vec3<f32> {
  let toLight  = normalize(ubo.lightPosition - fragPos);  // direccion hacia la luz
  let toCamera = normalize(ubo.eyePosition   - fragPos);  // direccion hacia la camara

  let ambient = ubo.Ka * ubo.lightTint;                   // luz ambiente siempre presente

  let NdL     = max(dot(surfNormal, toLight), 0.0);       // cuanto apunta la normal hacia la luz
  let diffuse = ubo.Kd * NdL * ubo.lightTint;             // luz difusa depende del angulo

  var specular = vec3<f32>(0.0);
  if NdL > 0.0 {
    // half-vector es el vector entre la luz y la camara
    let H   = normalize(toLight + toCamera);
    let NdH = max(dot(surfNormal, H), 0.0);
    specular = ubo.Ks * pow(NdH, ubo.shininess) * ubo.lightTint;
  }

  return (ambient + diffuse + specular) * surfColor;
}

// vertex shader: corre una vez por cada vertice
@vertex
fn vs_main(vtx: VertIn) -> VertOut {
  var out: VertOut;

  // transformo posicion y normal al espacio mundo
  let worldPos4 = ubo.worldMatrix  * vec4<f32>(vtx.pos, 1.0);
  let worldNrm4 = ubo.normalMatrix * vec4<f32>(vtx.nrm, 0.0);  // w=0 porque es direccion no punto

  out.clip     = ubo.mvpMatrix * vec4<f32>(vtx.pos, 1.0);  // posicion final en pantalla
  out.wPos     = worldPos4.xyz;
  out.wNrm     = normalize(worldNrm4.xyz);  // normalizo porque la escala puede deformarla
  out.bary     = vtx.bary;
  out.texCoord = vtx.uv;
  out.ndcDepth = out.clip.z / out.clip.w;   // depth en NDC [-1, 1]

  // en modo gouraud calculo la luz aqui por vertice
  // en los demas modos lo dejo en 0 y lo calculo en el fragment shader
  if ubo.shadingMode == 0u {
    out.gouraud = blinnPhong(out.wNrm, out.wPos, ubo.albedoColor);
  } else {
    out.gouraud = vec3<f32>(0.0);
  }

  return out;
}

// fragment shader: corre una vez por cada pixel de cada triangulo
@fragment
fn fs_main(frag: VertOut) -> @location(0) vec4<f32> {
  // renormalizo porque la interpolacion entre vertices puede acortar el vector
  let N = normalize(frag.wNrm);

  // color base del objeto, si hay textura la multiplico encima
  var surfColor = ubo.albedoColor;
  if ubo.texEnabled == 1u {
    surfColor = surfColor * textureSample(albedoTex, smp, frag.texCoord).rgb;
  }

  var outColor: vec3<f32>;

  switch ubo.shadingMode {
    case 0u: {
      // gouraud: el color ya viene calculado del vertex shader, solo lo paso
      outColor = frag.gouraud;
      if ubo.texEnabled == 1u {
        outColor = outColor * textureSample(albedoTex, smp, frag.texCoord).rgb;
      }
    }
    case 1u: {
      // phong: calculo la iluminacion por pixel con la normal interpolada
      outColor = blinnPhong(N, frag.wPos, surfColor);
    }
    case 2u: {
      // visualizo las normales como color: remap de [-1,1] a [0,1]
      // normal apuntando a +X = rojo, +Y = verde, +Z = azul
      outColor = N * 0.5 + vec3<f32>(0.5);
    }
    case 3u: {
      // wireframe usando coordenadas baricentricas
      // el pixel mas cercano a un borde tiene el minimo baricentrico cerca de 0
      let minBary  = min(frag.bary.x, min(frag.bary.y, frag.bary.z));
      let edgeMask = 1.0 - smoothstep(0.0, 0.018, minBary);  // suaviza el borde
      outColor     = vec3<f32>(1.0 - edgeMask);  // borde negro, relleno blanco
    }
    case 4u: {
      // depth: convierto la profundidad NDC a escala de grises
      let linearDepth = (frag.ndcDepth + 1.0) * 0.5;  // paso de [-1,1] a [0,1]
      outColor = vec3<f32>(linearDepth);
    }
    case 5u: {
      // textura con iluminacion phong encima
      let texSample = textureSample(albedoTex, smp, frag.texCoord).rgb;
      outColor = blinnPhong(N, frag.wPos, texSample);
    }
    default: {
      // modo UV: muestro las coordenadas de textura como color para debuggear
      outColor = vec3<f32>(frag.texCoord.x, frag.texCoord.y, 0.0);
    }
  }

  // si el objeto esta seleccionado le agrego un tinte amarillento
  if ubo.highlighted == 1u {
    outColor += vec3<f32>(0.08, 0.08, 0.0);
  }

  return vec4<f32>(outColor, 1.0);
}
`,I={add(e,t){return[e[0]+t[0],e[1]+t[1],e[2]+t[2]]},sub(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]},scale(e,t){return[e[0]*t,e[1]*t,e[2]*t]},dot(e,t){return e[0]*t[0]+e[1]*t[1]+e[2]*t[2]},cross(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]},normalize(e){const t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]}},y={identity(){const e=new Float32Array(16);return e[0]=1,e[5]=1,e[10]=1,e[15]=1,e},multiply(e,t){const n=new Float32Array(16);for(let o=0;o<4;o++)for(let r=0;r<4;r++)n[o*4+r]=e[0+r]*t[o*4+0]+e[4+r]*t[o*4+1]+e[8+r]*t[o*4+2]+e[12+r]*t[o*4+3];return n},transpose(e){const t=new Float32Array(16);for(let n=0;n<4;n++)for(let o=0;o<4;o++)t[o*4+n]=e[n*4+o];return t},invert(e){const t=new Float32Array(16),n=e[0],o=e[1],r=e[2],a=e[3],i=e[4],l=e[5],c=e[6],d=e[7],g=e[8],s=e[9],u=e[10],f=e[11],m=e[12],x=e[13],v=e[14],E=e[15],z=n*l-o*i,C=n*c-r*i,p=n*d-a*i,U=o*c-r*l,A=o*d-a*l,R=r*d-a*c,_=g*x-s*m,O=g*v-u*m,j=g*E-f*m,D=s*v-u*x,F=s*E-f*x,G=u*E-f*v;let w=z*G-C*F+p*D+U*j-A*O+R*_;return w?(w=1/w,t[0]=(l*G-c*F+d*D)*w,t[1]=(c*j-i*G-d*O)*w,t[2]=(i*F-l*j+d*_)*w,t[3]=(l*O-i*D-c*_)*w,t[4]=(r*F-o*G-a*D)*w,t[5]=(n*G-r*j+a*O)*w,t[6]=(o*j-n*F-a*_)*w,t[7]=(n*D-o*O+r*_)*w,t[8]=(x*R-v*A+E*U)*w,t[9]=(v*p-m*R-E*C)*w,t[10]=(m*A-x*p+E*z)*w,t[11]=(x*C-m*U-v*z)*w,t[12]=(u*A-s*R-f*U)*w,t[13]=(g*R-u*p+f*C)*w,t[14]=(s*p-g*A-f*z)*w,t[15]=(g*U-s*C+u*z)*w,t):y.identity()},normalMatrix(e){return y.transpose(y.invert(e))},translation(e,t,n){const o=y.identity();return o[12]=e,o[13]=t,o[14]=n,o},scaling(e,t,n){const o=y.identity();return o[0]=e,o[5]=t,o[10]=n,o},rotationX(e){const t=Math.cos(e),n=Math.sin(e),o=y.identity();return o[5]=t,o[6]=n,o[9]=-n,o[10]=t,o},rotationY(e){const t=Math.cos(e),n=Math.sin(e),o=y.identity();return o[0]=t,o[2]=-n,o[8]=n,o[10]=t,o},rotationZ(e){const t=Math.cos(e),n=Math.sin(e),o=y.identity();return o[0]=t,o[1]=n,o[4]=-n,o[5]=t,o},perspective(e,t,n,o){const r=1/Math.tan(e/2),a=new Float32Array(16);return a[0]=r/t,a[5]=r,a[10]=o/(n-o),a[11]=-1,a[14]=o*n/(n-o),a},lookAt(e,t,n){const o=I.normalize(I.sub(e,t)),r=I.normalize(I.cross(n,o)),a=I.cross(o,r),i=new Float32Array(16);return i[0]=r[0],i[4]=r[1],i[8]=r[2],i[12]=-I.dot(r,e),i[1]=a[0],i[5]=a[1],i[9]=a[2],i[13]=-I.dot(a,e),i[2]=o[0],i[6]=o[1],i[10]=o[2],i[14]=-I.dot(o,e),i[3]=0,i[7]=0,i[11]=0,i[15]=1,i}};function N(){return[0,0,0,1]}function k(e,t){const[n,o,r,a]=e,[i,l,c,d]=t;return[a*i+n*d+o*c-r*l,a*l-n*c+o*d+r*i,a*c+n*l-o*i+r*d,a*d-n*i-o*l-r*c]}function $(e){const t=Math.hypot(e[0],e[1],e[2],e[3])||1;return[e[0]/t,e[1]/t,e[2]/t,e[3]/t]}function X(e){const[t,n,o,r]=e,a=new Float32Array(16);return a[0]=1-2*(n*n+o*o),a[4]=2*(t*n-o*r),a[8]=2*(t*o+n*r),a[12]=0,a[1]=2*(t*n+o*r),a[5]=1-2*(t*t+o*o),a[9]=2*(n*o-t*r),a[13]=0,a[2]=2*(t*o-n*r),a[6]=2*(n*o+t*r),a[10]=1-2*(t*t+n*n),a[14]=0,a[3]=0,a[7]=0,a[11]=0,a[15]=1,a}function Q(e,t){const n=e*e+t*t;if(n<=1)return[e,t,Math.sqrt(1-n)];const o=Math.sqrt(n);return[e/o,t/o,0]}function pt(e,t){const[n,o,r]=e,[a,i,l]=t,c=Math.min(1,n*a+o*i+r*l),d=Math.acos(c);if(d<1e-6)return N();const g=o*l-r*i,s=r*a-n*l,u=n*i-o*a,f=Math.hypot(g,s,u);if(f<1e-10)return N();const m=Math.sin(d*.5)/f;return $([g*m,s*m,u*m,Math.cos(d*.5)])}class ht{rotation=N();dragRotation=N();dragStart=null;camAzimuth=0;camElevation=.3;camDragging=!1;camDragLastX=0;camDragLastY=0;_distance=9;_radius=1;_far=30;objectSelected=!1;canvas;constructor(t){this.canvas=t,this._bindEvents()}get distance(){return this._distance}saveRotation(){return this._commitDrag(),[...this.rotation]}loadRotation(t){this.rotation=[...t],this.dragRotation=N(),this.dragStart=null}getObjectRotationMatrix(){return X($(k(this.dragRotation,this.rotation)))}getViewMatrix(t){const n=this._eyeOffset(),o=[t[0]+n[0],t[1]+n[1],t[2]+n[2]];return y.lookAt(o,t,[0,1,0])}getCamPos(t){const n=this._eyeOffset();return[t[0]+n[0],t[1]+n[1],t[2]+n[2]]}getNearFar(){return[Math.max(.001,this._distance*.01),this._far]}fitCamera(t,n){this._radius=n,this._distance=n*2.5,this._far=n*10,this.camAzimuth=0,this.camElevation=.3}_eyeOffset(){const t=Math.cos(this.camElevation),n=Math.sin(this.camElevation),o=Math.cos(this.camAzimuth),r=Math.sin(this.camAzimuth);return[this._distance*t*r,this._distance*n,this._distance*t*o]}_commitDrag(){this.dragStart&&(this.rotation=$(k(this.dragRotation,this.rotation)),this.dragRotation=N(),this.dragStart=null)}_toNDC(t,n){const o=this.canvas.getBoundingClientRect();return[(t-o.left)/o.width*2-1,-((n-o.top)/o.height)*2+1]}_bindEvents(){this.canvas.addEventListener("mousedown",n=>{if(n.button!==0)return;const[o,r]=this._toNDC(n.clientX,n.clientY),a=Q(o,r);this.objectSelected?(this.dragStart=a,this.dragRotation=N()):(this.camDragging=!0,this.camDragLastX=o,this.camDragLastY=r)}),this.canvas.addEventListener("mousemove",n=>{const[o,r]=this._toNDC(n.clientX,n.clientY),a=Q(o,r);if(this.objectSelected&&this.dragStart)this.dragRotation=pt(this.dragStart,a);else if(!this.objectSelected&&this.camDragging){const i=o-this.camDragLastX,l=r-this.camDragLastY;this.camAzimuth+=i*Math.PI,this.camElevation=Math.max(-Math.PI/2+.01,Math.min(Math.PI/2-.01,this.camElevation+l*Math.PI)),this.camDragLastX=o,this.camDragLastY=r}});const t=()=>{this.objectSelected&&this.dragStart?(this.rotation=$(k(this.dragRotation,this.rotation)),this.dragRotation=N(),this.dragStart=null):this.objectSelected||(this.camDragging=!1)};this.canvas.addEventListener("mouseup",t),this.canvas.addEventListener("mouseleave",t),this.canvas.addEventListener("wheel",n=>{n.preventDefault(),this._distance*=1+n.deltaY*.001,this._distance=Math.max(this._radius*1.05||.5,this._distance)},{passive:!1})}}if(!navigator.gpu)throw new Error("WebGPU not supported in this browser");const L=document.querySelector("#gfx-main");if(!L)throw new Error("Could not find canvas #gfx-main");const et=await navigator.gpu.requestAdapter();if(!et)throw new Error("No suitable GPU adapter found");const M=await et.requestDevice(),nt=L.getContext("webgpu"),ot=navigator.gpu.getPreferredCanvasFormat();let K=null;function rt(){L.width=Math.max(1,Math.floor(window.innerWidth*devicePixelRatio)),L.height=Math.max(1,Math.floor(window.innerHeight*devicePixelRatio)),nt.configure({device:M,format:ot,alphaMode:"premultiplied"}),K?.destroy(),K=M.createTexture({size:[L.width,L.height],format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT})}rt();window.addEventListener("resize",rt);const W=352,J=M.createShaderModule({label:"main-shader",code:mt}),at=M.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float"}}]}),gt=M.createRenderPipeline({layout:M.createPipelineLayout({bindGroupLayouts:[at]}),vertex:{module:J,entryPoint:"vs_main",buffers:[{arrayStride:44,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x3"},{shaderLocation:3,offset:36,format:"float32x2"}]}]},fragment:{module:J,entryPoint:"fs_main",targets:[{format:ot}]},primitive:{topology:"triangle-list",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"}}),bt=M.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"repeat",addressModeV:"repeat"});function vt(){const e=M.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});return M.queue.writeTexture({texture:e},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]),e}function xt(e,t){const n=t.length/3,o=new Float32Array(n*3*11),r=[[1,0,0],[0,1,0],[0,0,1]];for(let a=0;a<n;a++)for(let i=0;i<3;i++){const l=t[a*3+i],c=(a*3+i)*11;o[c]=e[l*8],o[c+1]=e[l*8+1],o[c+2]=e[l*8+2],o[c+3]=e[l*8+3],o[c+4]=e[l*8+4],o[c+5]=e[l*8+5],o[c+6]=r[i][0],o[c+7]=r[i][1],o[c+8]=r[i][2],o[c+9]=e[l*8+6],o[c+10]=e[l*8+7]}return o}function yt(e){const t=M.createBuffer({size:e.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});return M.queue.writeBuffer(t,0,e.buffer),t}function it(e,t){const n=[];for(let r=0;r<=e;r++){const a=Math.PI*r/e,i=Math.cos(a),l=Math.sin(a);for(let c=0;c<=t;c++){const d=2*Math.PI*c/t,g=l*Math.cos(d),s=i,u=l*Math.sin(d);n.push(g,s,u,g,s,u,c/t,r/e)}}const o=[];for(let r=0;r<e;r++)for(let a=0;a<t;a++){const i=r*(t+1)+a,l=i+1,c=i+(t+1),d=c+1;o.push(i,c,l,l,c,d)}return{vd:new Float32Array(n),id:new Uint32Array(o)}}function st(){const e=[{n:[0,0,1],v:[[-1,-1,1,0,1],[1,-1,1,1,1],[1,1,1,1,0],[-1,1,1,0,0]]},{n:[0,0,-1],v:[[1,-1,-1,0,1],[-1,-1,-1,1,1],[-1,1,-1,1,0],[1,1,-1,0,0]]},{n:[-1,0,0],v:[[-1,-1,-1,0,1],[-1,-1,1,1,1],[-1,1,1,1,0],[-1,1,-1,0,0]]},{n:[1,0,0],v:[[1,-1,1,0,1],[1,-1,-1,1,1],[1,1,-1,1,0],[1,1,1,0,0]]},{n:[0,1,0],v:[[-1,1,1,0,1],[1,1,1,1,1],[1,1,-1,1,0],[-1,1,-1,0,0]]},{n:[0,-1,0],v:[[-1,-1,-1,0,1],[1,-1,-1,1,1],[1,-1,1,1,0],[-1,-1,1,0,0]]}],t=[],n=[];let o=0;for(const r of e){for(const a of r.v)t.push(a[0],a[1],a[2],...r.n,a[3],a[4]);n.push(o,o+1,o+2,o,o+2,o+3),o+=4}return{vd:new Float32Array(t),id:new Uint32Array(n)}}function tt(e,t){return[e[0]-t[0],e[1]-t[1],e[2]-t[2]]}function wt(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}function Mt(e){const t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]}function Ct(e){const t=[],n=[],o=[];for(const s of e.split(`
`)){const u=s.trim();if(!u||u[0]==="#")continue;const f=u.split(/\s+/);if(f[0]==="v")t.push([parseFloat(f[1]),parseFloat(f[2]),parseFloat(f[3])]);else if(f[0]==="vt")n.push([parseFloat(f[1]),parseFloat(f[2])]);else if(f[0]==="f"){const m=f.slice(1).map(x=>{const v=x.split("/"),E=parseInt(v[0])-1,z=v[1]&&v[1]!==""?parseInt(v[1])-1:null;return[E,z]});for(let x=1;x+1<m.length;x++)o.push([m[0],m[x],m[x+1]])}}const r=t.length,a=o.length,i=n.length>0,l=new Float32Array(r*3),c=new Float32Array(r*3),d=new Float32Array(r*2),g=new Uint32Array(a*3);for(let s=0;s<r;s++)l[s*3]=t[s][0],l[s*3+1]=t[s][1],l[s*3+2]=t[s][2];for(let s=0;s<a;s++){const[[u,f],[m,x],[v,E]]=o[s],z=Mt(wt(tt(t[m],t[u]),tt(t[v],t[u])));for(const C of[u,m,v])c[C*3]+=z[0],c[C*3+1]+=z[1],c[C*3+2]+=z[2];if(g[s*3]=u,g[s*3+1]=m,g[s*3+2]=v,i)for(const[C,p]of[[u,f],[m,x],[v,E]])p!==null&&d[C*2]===0&&d[C*2+1]===0&&(d[C*2]=n[p][0],d[C*2+1]=1-n[p][1])}for(let s=0;s<r;s++){const u=Math.hypot(c[s*3],c[s*3+1],c[s*3+2])||1;c[s*3]/=u,c[s*3+1]/=u,c[s*3+2]/=u}if(!i)for(let s=0;s<r;s++){const u=c[s*3],f=c[s*3+1],m=c[s*3+2];d[s*2]=.5+Math.atan2(m,u)/(2*Math.PI),d[s*2+1]=.5-Math.asin(Math.max(-1,Math.min(1,f)))/Math.PI}return{positions:l,normals:c,uvCoords:d,indices:g,numVerts:r,numTris:a}}function Et(e){const t=new Float32Array(e.numVerts*8);for(let n=0;n<e.numVerts;n++)t[n*8]=e.positions[n*3],t[n*8+1]=e.positions[n*3+1],t[n*8+2]=e.positions[n*3+2],t[n*8+3]=e.normals[n*3],t[n*8+4]=e.normals[n*3+1],t[n*8+5]=e.normals[n*3+2],t[n*8+6]=e.uvCoords[n*2],t[n*8+7]=e.uvCoords[n*2+1];return{vd:t,id:e.indices}}function zt(e){let t=1/0,n=1/0,o=1/0,r=-1/0,a=-1/0,i=-1/0;for(let s=0;s<e.numVerts;s++){const u=e.positions[s*3],f=e.positions[s*3+1],m=e.positions[s*3+2];u<t&&(t=u),u>r&&(r=u),f<n&&(n=f),f>a&&(a=f),m<o&&(o=m),m>i&&(i=m)}const l=(t+r)*.5,c=(n+a)*.5,d=(o+i)*.5;let g=0;for(let s=0;s<e.numVerts;s++){const u=e.positions[s*3]-l,f=e.positions[s*3+1]-c,m=e.positions[s*3+2]-d,x=Math.sqrt(u*u+f*f+m*m);x>g&&(g=x)}return{center:[l,c,d],radius:g}}function St(){return{tx:0,ty:0,tz:0,rx:0,ry:0,rz:0,sx:1,sy:1,sz:1}}function Pt(){return{ambient:.12,diffuse:.75,specular:.55,shininess:48,color:"#4a9eff"}}let Tt=0;class Bt{uid=Tt++;label;gpuVtx;drawCount;gpuUBO;albedo;bindGroup;useTexture=0;xform;material;savedQuat=[0,0,0,1];uboBuffer=new ArrayBuffer(W);uboF32=new Float32Array(this.uboBuffer);uboU32=new Uint32Array(this.uboBuffer);constructor(t,n,o){this.label=t,this.gpuVtx=n,this.drawCount=o,this.xform=St(),this.material=Pt(),this.albedo=vt(),this.gpuUBO=M.createBuffer({size:W,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.bindGroup=this._buildBindGroup()}center(){return[this.xform.tx,this.xform.ty,this.xform.tz]}assignTexture(t){this.albedo.destroy(),this.albedo=t,this.useTexture=1,this.bindGroup=this._buildBindGroup()}modelMatrix(t){const{tx:n,ty:o,tz:r,rx:a,ry:i,rz:l,sx:c,sy:d,sz:g}=this.xform,s=y.translation(n,o,r),u=y.scaling(c,d,g),f=y.multiply(y.rotationZ(l),y.multiply(y.rotationY(i),y.multiply(y.rotationX(a),t)));return y.multiply(s,y.multiply(f,u))}syncUniforms(t,n,o,r,a,i,l,c,d){const g=this.modelMatrix(t),s=y.normalMatrix(g),u=y.multiply(o,y.multiply(n,g)),[f,m,x]=a,v=this.material,[E,z,C]=ct(v.color),p=this.uboF32,U=this.uboU32;p.set(u,0),p.set(g,16),p.set(s,32),p.set(n,48),p[64]=r[0],p[65]=r[1],p[66]=r[2],p[67]=0,p[68]=f,p[69]=m,p[70]=x,p[71]=0,p[72]=v.ambient,p[73]=v.diffuse,p[74]=v.specular,p[75]=v.shininess,p[76]=i[0],p[77]=i[1],p[78]=i[2],U[79]=l,p[80]=E,p[81]=z,p[82]=C,U[83]=this.useTexture,p[84]=c,U[85]=d?1:0,M.queue.writeBuffer(this.gpuUBO,0,this.uboBuffer)}free(){this.gpuVtx.destroy(),this.gpuUBO.destroy(),this.albedo.destroy()}_buildBindGroup(){return M.createBindGroup({layout:at,entries:[{binding:0,resource:{buffer:this.gpuUBO}},{binding:1,resource:bt},{binding:2,resource:this.albedo.createView()}]})}}function q(e,t,n){return new Bt(e,yt(xt(t,n)),n.length)}async function Ut(e,t){const n=Ct(t),{vd:o,id:r}=Et(n),a=q(e,o,r),i=zt(n);return a.xform.tx=-i.center[0],a.xform.ty=-i.center[1],a.xform.tz=-i.center[2],B.fitCamera(i.center,i.radius),a}const b=[];let h=-1;const B=new ht(L);B.objectSelected=!1;function Lt(){return h>=0&&b[h]?b[h].center():[0,0,0]}function Y(e){h>=0&&b[h]&&(b[h].savedQuat=B.saveRotation()),h=e,e>=0&&b[e]?(B.objectSelected=!0,B.loadRotation(b[e].savedQuat)):B.objectSelected=!1,ut(),dt()}function H(e){b.push(e),Y(b.length-1)}function It(){h<0||b.length===0||(b[h].savedQuat=B.saveRotation(),b[h].free(),b.splice(h,1),Y(b.length===0?-1:Math.max(0,h-1)))}const V={renderMode:1,lightColor:"#ffffff"};function ct(e){const t=parseInt(e.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}function S(e,t,n,o,r,a){const i=Number.isInteger(a)?String(a):a.toFixed(2);return`<div class="slider-row">
    <span class="slider-label">${t}</span>
    <input type="range" id="${e}" min="${n}" max="${o}" step="${r}" value="${a}">
    <span class="slider-val" id="${e}-val">${i}</span></div>`}const Nt={0:"Gouraud: lighting computed per vertex, colour interpolated across face.",1:"Phong: normals interpolated per fragment, full lighting per pixel.",2:"Normal buffer: world-space normals encoded as RGB (R=X  G=Y  B=Z).",3:"Wireframe: black edges on white background. Depth buffer removes hidden surfaces.",4:"Depth: linearised NDC depth shown as greyscale.",5:"Texture: spherical UV map multiplied by Phong shading.",6:"UV visualiser: U channel → Red,  V channel → Green."},Z=document.createElement("div");Z.id="gui";Z.innerHTML=`
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
    ${S("tr-tx","Translate X",-12,12,.05,0)}
    ${S("tr-ty","Translate Y",-12,12,.05,0)}
    ${S("tr-tz","Translate Z",-12,12,.05,0)}
    ${S("tr-rx","Rotate X",-3.15,3.15,.01,0)}
    ${S("tr-ry","Rotate Y",-3.15,3.15,.01,0)}
    ${S("tr-rz","Rotate Z",-3.15,3.15,.01,0)}
    ${S("tr-sx","Scale X",.05,6,.05,1)}
    ${S("tr-sy","Scale Y",.05,6,.05,1)}
    ${S("tr-sz","Scale Z",.05,6,.05,1)}
    <div class="gui-label">Material</div>
    ${S("mt-ambient","Ambient (Ka)",0,1,.01,.12)}
    ${S("mt-diffuse","Diffuse (Kd)",0,1,.01,.75)}
    ${S("mt-specular","Specular (Ks)",0,1,.01,.55)}
    ${S("mt-shine","Shininess (n)",1,256,1,48)}
    <div class="color-row" style="margin-top:4px">
      <span>Object color</span><input type="color" id="mt-color" value="#4a9eff">
    </div>
    <div class="gui-label">Texture (spherical UV)</div>
    <input type="file" id="tex-upload" accept="image/*" class="file-input">
    <label class="checkbox-row"><input type="checkbox" id="use-texture"> Use texture</label>
  </div>
</div>`;document.body.appendChild(Z);function lt(){document.getElementById("mode-desc").textContent=Nt[V.renderMode]}lt();document.querySelectorAll(".mode-btn").forEach(e=>{e.addEventListener("click",()=>{V.renderMode=Number(e.dataset.id),document.querySelectorAll(".mode-btn").forEach(t=>t.classList.remove("active")),e.classList.add("active"),lt()})});document.getElementById("add-sphere").addEventListener("click",()=>{H(q("Sphere",...Object.values(it(64,64))))});document.getElementById("add-cube").addEventListener("click",()=>{H(q("Cube",...Object.values(st())))});document.getElementById("obj-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];t&&H(await Ut(t.name.replace(".obj",""),await t.text()))});document.getElementById("btn-deselect").addEventListener("click",()=>Y(-1));document.getElementById("btn-remove").addEventListener("click",It);document.getElementById("g-lightColor").addEventListener("input",e=>{V.lightColor=e.target.value});function ut(){const e=document.getElementById("object-list");e.innerHTML="",b.forEach((t,n)=>{const o=document.createElement("button");o.className="obj-list-btn"+(n===h?" active":""),o.textContent=`${n+1}. ${t.label}`,o.addEventListener("click",()=>Y(n===h?-1:n)),e.appendChild(o)})}function P(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&(n.value=String(t)),o&&(o.textContent=Number.isInteger(t)?String(t):t.toFixed(2))}function dt(){const e=document.getElementById("inspector-title");if(h<0||!b[h]){e.textContent="No selection — camera orbit mode";return}const t=b[h];e.textContent=t.label;const n=t.xform;P("tr-tx",n.tx),P("tr-ty",n.ty),P("tr-tz",n.tz),P("tr-rx",n.rx),P("tr-ry",n.ry),P("tr-rz",n.rz),P("tr-sx",n.sx),P("tr-sy",n.sy),P("tr-sz",n.sz);const o=t.material;P("mt-ambient",o.ambient),P("mt-diffuse",o.diffuse),P("mt-specular",o.specular),P("mt-shine",o.shininess),document.getElementById("mt-color").value=o.color,document.getElementById("use-texture").checked=t.useTexture===1}function T(e,t){const n=document.getElementById(e),o=document.getElementById(`${e}-val`);n&&n.addEventListener("input",()=>{const r=parseFloat(n.value);o&&(o.textContent=Number.isInteger(r)?String(r):r.toFixed(2)),h>=0&&b[h]&&t(b[h],r)})}T("tr-tx",(e,t)=>{e.xform.tx=t});T("tr-ty",(e,t)=>{e.xform.ty=t});T("tr-tz",(e,t)=>{e.xform.tz=t});T("tr-rx",(e,t)=>{e.xform.rx=t});T("tr-ry",(e,t)=>{e.xform.ry=t});T("tr-rz",(e,t)=>{e.xform.rz=t});T("tr-sx",(e,t)=>{e.xform.sx=t});T("tr-sy",(e,t)=>{e.xform.sy=t});T("tr-sz",(e,t)=>{e.xform.sz=t});T("mt-ambient",(e,t)=>{e.material.ambient=t});T("mt-diffuse",(e,t)=>{e.material.diffuse=t});T("mt-specular",(e,t)=>{e.material.specular=t});T("mt-shine",(e,t)=>{e.material.shininess=t});document.getElementById("mt-color").addEventListener("input",e=>{h>=0&&b[h]&&(b[h].material.color=e.target.value)});document.getElementById("tex-upload").addEventListener("change",async e=>{const t=e.target.files?.[0];if(!t||h<0||!b[h])return;const n=await createImageBitmap(t,{colorSpaceConversion:"none"}),o=M.createTexture({size:[n.width,n.height],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});M.queue.copyExternalImageToTexture({source:n},{texture:o},[n.width,n.height]),b[h].assignTexture(o),document.getElementById("use-texture").checked=!0});document.getElementById("use-texture").addEventListener("change",e=>{h>=0&&b[h]&&(b[h].useTexture=e.target.checked?1:0)});{const{vd:e,id:t}=it(64,64),n=q("Sphere",e,t);n.xform.tx=-2.5,b.push(n)}{const{vd:e,id:t}=st(),n=q("Cube",e,t);n.xform.tx=2.5,b.push(n)}h=-1;B.objectSelected=!1;ut();dt();const At=performance.now();function ft(e){const t=(e-At)/1e3,n=L.width/L.height,[o,r]=B.getNearFar(),a=y.perspective(60*Math.PI/180,n,o,r),i=ct(V.lightColor),l=Lt(),c=B.getViewMatrix(l),d=B.getCamPos(l),g=[d[0],d[1]+5,d[2]],s=X([0,0,0,1]),u=h>=0&&b[h]?B.getObjectRotationMatrix():s,f=M.createCommandEncoder(),m=f.beginRenderPass({colorAttachments:[{view:nt.getCurrentTexture().createView(),clearValue:{r:.08,g:.08,b:.12,a:1},loadOp:"clear",storeOp:"store"}],depthStencilAttachment:{view:K.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"store"}});m.setPipeline(gt);for(let x=0;x<b.length;x++){const v=b[x],E=x===h,z=E?u:X(v.savedQuat);v.syncUniforms(z,c,a,g,i,d,V.renderMode,t,E),m.setBindGroup(0,v.bindGroup),m.setVertexBuffer(0,v.gpuVtx),m.draw(v.drawCount)}m.end(),M.queue.submit([f.finish()]),requestAnimationFrame(ft)}requestAnimationFrame(ft);
