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

// vision.json mirrors the vc_* constants; vc_YH.w is the engine's exposure.
export function parseVisionGrade(json) {
  if (!json || typeof json !== 'object') return null;
  const exposure = Number(json.exposure);
  return {
    exposure: Number.isFinite(exposure) && exposure > 0 ? exposure : 1,
    highlight: Array.isArray(json.highlight) ? json.highlight : [1, 1, 1],
    lowlight: Array.isArray(json.lowlight) ? json.lowlight : [0, 0, 0],
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
export const LUT_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    lut: { value: null },
    amount: { value: 1 },
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
    varying vec2 vUv;

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
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      gl_FragColor = vec4(mix(c, sampleLut(c), amount), src.a);
    }`,
};

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
    renderer.toneMappingExposure = grade.exposure;
    applied.tone = true;
    applied.exposure = grade.exposure;
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
