// todos los datos que le mando desde el CPU a cada objeto
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
