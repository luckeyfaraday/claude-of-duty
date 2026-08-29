// Environment lighting driven by the map's own shipped assets.
//
// .tools/bake_env.mjs converts the engine's skybox and reflection probe
// cubemaps into glTF-oriented PNG faces, and parses mp_hijacked.vision into
// vision.json. This module loads them and configures the renderer:
//
//   scene.background  the real sky instead of a flat blue clear colour
//   scene.environment a prefiltered probe, so metal/glass get real specular
//   tone mapping      ACES with the vision set's authored exposure
//   fog colour        sampled from the sky's own horizon band
//
// Everything degrades gracefully: if an asset is missing the viewer keeps its
// previous look rather than rendering black.

import * as THREE from 'three';

export const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// Hijacked is a hazy sunset: in the game, deck furniture a few tens of metres
// out is already washing toward the horizon colour, and nothing reads as a
// hard silhouette. The viewer's original 1500/9000 was far too clear for that.
// Units are roughly inches, so 900 is about 20m and 5200 about 130m.
export const HAZE = { near: 900, far: 5200 };

// vision.json mirrors the vc_* constants. vc_YH/vc_YL are the authored
// highlight and lowlight tone targets; the LUT built from the same vision set
// is what actually carries the map's look here.
//
// vc_YH.w is NOT a renderer exposure. It was applied as one at first and it
// visibly washed the image out - it belongs to the engine's own tone curve,
// which is not the ACES curve used here. It is parsed and reported so the
// values are available, but exposure is a separate, tuned setting.
export function parseVisionGrade(json) {
  if (!json || typeof json !== 'object') return null;
  const visionExposure = Number(json.exposure);
  return {
    highlight: Array.isArray(json.highlight) ? json.highlight : [1, 1, 1],
    lowlight: Array.isArray(json.lowlight) ? json.lowlight : [0, 0, 0],
    visionExposure: Number.isFinite(visionExposure) ? visionExposure : null,
  };
}

function loadCube(basePath) {
  return new Promise((resolve, reject) => {
    new THREE.CubeTextureLoader()
      .setPath(basePath)
      .load(
        FACE_ORDER.map((f) => `${f}.png`),
        resolve,
        undefined,
        () => reject(new Error(`cube texture not found at ${basePath}`)),
      );
  });
}

// Average the equatorial band of the +X/-X/+Z/-Z faces. Fog that matches the
// sky's horizon stops distant geometry reading as a grey wall.
export function horizonColorFromFaces(faces, size, band = 0.25) {
  const y0 = Math.floor(size * (0.5 - band / 2));
  const y1 = Math.ceil(size * (0.5 + band / 2));
  let r = 0, g = 0, b = 0, n = 0;
  for (const px of faces) {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 3;
        r += px[o]; g += px[o + 1]; b += px[o + 2];
        n++;
      }
    }
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
}

// Read the horizon tint straight off the loaded cube texture's images.
function sampleHorizonFromTexture(cube) {
  const images = cube?.image;
  if (!Array.isArray(images) || images.length < 6) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  let r = 0, g = 0, b = 0, n = 0;
  // side faces only: px, nx, pz, nz
  for (const index of [0, 1, 4, 5]) {
    const img = images[index];
    const w = img.width, h = img.height;
    if (!w || !h) continue;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0);
    const y0 = Math.floor(h * 0.4);
    const strip = ctx.getImageData(0, y0, w, Math.max(1, Math.floor(h * 0.2))).data;
    for (let i = 0; i < strip.length; i += 4) {
      r += strip[i]; g += strip[i + 1]; b += strip[i + 2];
      n++;
    }
  }
  if (!n) return null;
  return new THREE.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
}

// mp_hijacked_lut_win.dds is the vision set's colour grade, measured layout:
// 32 tiles of 32px across (blue), red along x within a tile, green down y.
// The 64 rows are two stacked 32-level tables - rows 0-31 are the graded pass
// (mean deviation from identity 5.8) and rows 32-63 a near-identity one (3.0).
// Rows 0-31 are used. Blue slices and green rows are both interpolated so the
// grade does not band.
// This is the output pass, not just a grade. THREE only compiles tone mapping
// into materials when rendering to the canvas - for a render target it forces
// NoToneMapping - so a scene drawn into an offscreen target arrives here raw
// and linear. Exposure, the ACES curve and the sRGB encode therefore all have
// to happen in this shader, before the LUT, which expects display-referred
// input. Doing the LUT without them clips highlights and crushes shadows.
export const POST_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    lut: { value: null },
    amount: { value: 1 },
    exposure: { value: 1 },
    toneMap: { value: 1 },
    lift: { value: new THREE.Vector3(0, 0, 0) },
    highlightTint: { value: new THREE.Vector3(1, 1, 1) },
    visionAmount: { value: 1 },
    saturation: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D lut;
    uniform float amount;
    uniform float exposure;
    uniform float toneMap;
    uniform vec3 lift;
    uniform vec3 highlightTint;
    uniform float visionAmount;
    uniform float saturation;
    varying vec2 vUv;

    // The vision set's split tone: vc_YH is a warm highlight target and vc_YL a
    // cool lowlight one sitting around 3% rather than at zero. Applying both is
    // what stops the image reading as crushed and over-blue next to the game.
    vec3 hjVision(vec3 c) {
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 warmed = c * mix(vec3(1.0), highlightTint, y);
      vec3 lifted = lift + warmed * (1.0 - lift);
      return mix(c, lifted, visionAmount);
    }

    // ACES, the warm highlight tint and the LUT each add a little saturation,
    // and they compound into clouds far more vivid than the game's. Pulled
    // back once at the end rather than by weakening each stage.
    vec3 hjSaturation(vec3 c, float s) {
      return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, s);
    }

    // Matches THREE's ACESFilmicToneMapping so the look is unchanged from
    // rendering straight to the canvas.
    vec3 hjRRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 hjAcesFilmic(vec3 color) {
      const mat3 hjACESInputMat = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
      );
      const mat3 hjACESOutputMat = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
      );
      color *= exposure / 0.6;
      color = hjACESInputMat * color;
      color = hjRRTAndODTFit(color);
      color = hjACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    vec3 hjLinearToSRGB(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }

    vec3 sampleLut(vec3 c) {
      float blue = c.b * 31.0;
      float b0 = floor(blue);
      float bf = blue - b0;
      float green = c.g * 31.0;
      float g0 = floor(green);
      float gf = green - g0;
      float red = c.r * 31.0;
      float u0 = (b0 * 32.0 + 0.5 + red) / 1024.0;
      float u1 = (min(b0 + 1.0, 31.0) * 32.0 + 0.5 + red) / 1024.0;
      // the cube occupies the top 32 rows of the 64-row strip
      float v0 = (g0 + 0.5) / 64.0;
      float v1 = (min(g0 + 1.0, 31.0) + 0.5) / 64.0;
      vec3 s0 = mix(texture2D(lut, vec2(u0, v0)).rgb, texture2D(lut, vec2(u0, v1)).rgb, gf);
      vec3 s1 = mix(texture2D(lut, vec2(u1, v0)).rgb, texture2D(lut, vec2(u1, v1)).rgb, gf);
      return mix(s0, s1, bf);
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      // scene arrives linear and unbounded
      vec3 c = src.rgb;
      c = toneMap > 0.5 ? hjAcesFilmic(c) : clamp(c * exposure, 0.0, 1.0);
      c = hjLinearToSRGB(c);
      // vision split tone, then the LUT built from the same vision set
      c = hjVision(c);
      c = mix(c, sampleLut(c), amount);
      gl_FragColor = vec4(clamp(hjSaturation(c, saturation), 0.0, 1.0), src.a);
    }`,
};

// compose_scene.py gives every world material metalness 0 / roughness 0.9,
// because until now there was no environment for a metal to reflect. That makes
// chrome render as a rough dielectric over a dark albedo - the chrome map is a
// flat ~#3c3c3c, since in the engine its whole appearance comes from
// reflection - so railings and trim collapse to black silhouettes.
//
// First match wins, so the explicitly-dielectric rule is listed first: plenty
// of names contain "metal" while being painted or plastic, and those really are
// rough dielectrics.
export const MATERIAL_CLASSES = [
  { match: /painted|whitetrim|plastic|rubber|wood|fabric|leather/i, metalness: 0, roughness: 0.9 },
  { match: /chrome/i, metalness: 1, roughness: 0.16 },
  { match: /brushed/i, metalness: 1, roughness: 0.45 },
  { match: /metal|steel|alum|iron/i, metalness: 1, roughness: 0.35 },
];

// Names arrive as "model:material" or "material:decal_overlay", sometimes
// behind a "*33n_95(" surface prefix. The overlay half must not decide the
// class - "com_metal_chrome_trim:pb_decal_wall_fillet" is chrome with a decal
// on it, not a dielectric.
export function materialProbeName(name) {
  const cleaned = String(name).replace(/^\*[^(]*\(/, '');
  const segments = cleaned.split(':').filter((s) => !/decal|ao_|fillet/i.test(s));
  return segments.length ? segments.join(':') : cleaned;
}

export function classifyMaterial(name) {
  if (!name) return null;
  const probe = materialProbeName(name);
  for (const rule of MATERIAL_CLASSES) {
    if (rule.match.test(probe)) return { metalness: rule.metalness, roughness: rule.roughness };
  }
  return null;
}

/**
 * Reclassify a loaded subtree's materials so metals reflect the environment.
 * Returns how many were changed.
 */
export function applyMaterialClasses(root) {
  const seen = new Set();
  let changed = 0;
  root.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      if (material.metalness === undefined) continue; // not a PBR material
      const cls = classifyMaterial(material.name);
      if (!cls) continue;
      material.metalness = cls.metalness;
      material.roughness = cls.roughness;
      material.needsUpdate = true;
      changed++;
    }
  });
  return changed;
}

/**
 * Turn the vision set's tone targets into post-pass uniforms.
 *
 * vc_YL is the lowlight target and sits near 0.03 with a blue bias, so it is
 * used directly as a black lift - the game's shadows are visibly raised and
 * slightly cool, never crushed. vc_YH is the highlight target and is warm
 * (R > G > B); only its hue matters here, so it is normalised to its max and
 * applied by luminance.
 */
export function visionTone(grade, { liftScale = 1, tintStrength = 0.35 } = {}) {
  const yl = grade?.lowlight ?? [0, 0, 0];
  const yh = grade?.highlight ?? [1, 1, 1];
  const peak = Math.max(yh[0], yh[1], yh[2]) || 1;
  return {
    lift: yl.map((v) => Math.min(Math.max(v * liftScale, 0), 0.25)),
    // Normalised vc_YH is [1, 0.92, 0.76] - a 24% cut to blue. Applied at full
    // strength and weighted by luminance it lands hardest on the brightest part
    // of the frame, which is the sunset, and drives the sky orange. The hue is
    // right but the magnitude is not a literal multiplier, so it is eased
    // toward neutral.
    highlightTint: yh.map((v) => 1 + (v / peak - 1) * tintStrength),
  };
}

/** Load the grading LUT texture, or null if it is not present. */
export function loadGradeLut(url = 'textures/mp_hijacked_lut.png') {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        // Row 0 of the file must stay row 0: the shader indexes the table by
        // absolute row, so Three's default vertical flip would invert green.
        texture.flipY = false;
        // The LUT stores display-referred values; sampling must not re-decode.
        texture.colorSpace = THREE.NoColorSpace;
        resolve(texture);
      },
      undefined,
      () => resolve(null),
    );
  });
}

/**
 * Load and apply the map's environment lighting.
 * Returns a summary of what actually took effect.
 */
export async function applyEnvironmentLighting(renderer, scene, options = {}) {
  const {
    envPath = 'textures/env/',
    probePath = 'textures/probe/',
    visionUrl = 'vision.json',
    fog = true,
    // The probe volume (light-probes.js) carries diffuse ambient, so the
    // environment map is turned down to mostly contribute specular. Raise this
    // if the volume is absent and the env map has to do both jobs.
    environmentIntensity = 0.45,
    // Tuned by eye against a capture of the real game, not derived: the vision
    // set's own numbers describe the engine's tone curve, not an ACES exposure.
    exposure = 1.0,
  } = options;

  const applied = { sky: false, environment: false, tone: false, fog: false };

  // --- vision set -> tone mapping
  let grade = null;
  try {
    const response = await fetch(visionUrl);
    if (response.ok) grade = parseVisionGrade(await response.json());
  } catch {
    // fall through: keep the renderer's existing tone mapping
  }
  if (grade) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure;
    applied.tone = true;
    applied.exposure = exposure;
    applied.vision = visionTone(grade);
    applied.visionExposure = grade.visionExposure;
  }

  // --- sky cubemap -> background
  let sky = null;
  try {
    sky = await loadCube(envPath);
    sky.colorSpace = THREE.SRGBColorSpace;
    scene.background = sky;
    applied.sky = true;
  } catch {
    // keep the flat clear colour
  }

  // --- reflection probe -> prefiltered specular environment.
  // The probe has no position in the dump, so it acts as one global source;
  // the sky is the fallback when the probe is unavailable.
  let source = null;
  try {
    source = await loadCube(probePath);
    source.colorSpace = THREE.SRGBColorSpace;
    applied.environmentSource = 'probe';
  } catch {
    source = sky;
    if (sky) applied.environmentSource = 'sky';
  }
  if (source) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    try {
      const prefiltered = pmrem.fromCubemap(source).texture;
      scene.environment = prefiltered;
      scene.environmentIntensity = environmentIntensity;
      applied.environmentIntensity = environmentIntensity;
      // Exposed so overlay scenes (the viewmodel) can share the same map.
      applied.environmentTexture = prefiltered;
      applied.environment = true;
    } finally {
      pmrem.dispose();
    }
  }

  // --- fog tinted to the sky's horizon
  if (fog && sky && scene.fog) {
    const tint = sampleHorizonFromTexture(sky);
    if (tint) {
      scene.fog.color.copy(tint);
      applied.fog = true;
    }
  }

  return applied;
}
