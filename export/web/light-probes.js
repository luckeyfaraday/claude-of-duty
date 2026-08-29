// Runtime sampler for the baked SH light probe volume.
//
// .tools/bake_probes.mjs walks a lattice over the map and integrates incoming
// radiance from the real sky cubemap against the collision geometry, projected
// onto L0+L1 spherical harmonics. That is the same basis THREE.LightProbe
// consumes, so a sampled cell can be handed straight to one - no custom shader.
//
// The volume replaces the static hemisphere light: instead of one fixed ambient
// everywhere, a position below decks gets a dimmer, less sky-tinted result than
// one out on the open deck.

import * as THREE from 'three';

export class ProbeVolume {
  constructor(layout, data) {
    if (!layout || !Array.isArray(layout.dims) || layout.dims.length !== 3) {
      throw new Error('probe volume needs dims[3]');
    }
    const [dx, dy, dz] = layout.dims;
    const expected = dx * dy * dz * 12;
    if (!(data instanceof Float32Array) || data.length < expected) {
      throw new Error(`probe data too small: ${data?.length ?? 0} < ${expected}`);
    }
    this.layout = layout;
    this.data = data;
    // scratch, so sampling allocates nothing per frame
    this._acc = new Float32Array(12);
  }

  /**
   * Trilinearly sample the volume at a world position.
   * Writes 4 SH coefficients of rgb into `out` (length 12) and returns it.
   */
  sample(x, y, z, out = new Float32Array(12)) {
    const { origin, spacing, dims } = this.layout;
    const [dx, dy, dz] = dims;
    const fx = clamp((x - origin[0]) / spacing, 0, dx - 1);
    const fy = clamp((y - origin[1]) / spacing, 0, dy - 1);
    const fz = clamp((z - origin[2]) / spacing, 0, dz - 1);
    const ix = Math.min(dx - 2, Math.floor(fx));
    const iy = Math.min(dy - 2, Math.floor(fy));
    const iz = Math.min(dz - 2, Math.floor(fz));
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;

    out.fill(0);
    for (let cx = 0; cx < 2; cx++) {
      const wx = cx ? tx : 1 - tx;
      if (wx === 0) continue;
      for (let cy = 0; cy < 2; cy++) {
        const wy = wx * (cy ? ty : 1 - ty);
        if (wy === 0) continue;
        for (let cz = 0; cz < 2; cz++) {
          const w = wy * (cz ? tz : 1 - tz);
          if (w === 0) continue;
          const cell = ((ix + cx) * dy + (iy + cy)) * dz + (iz + cz);
          const base = cell * 12;
          for (let i = 0; i < 12; i++) out[i] += w * this.data[base + i];
        }
      }
    }
    return out;
  }

  /**
   * Sample into a THREE.LightProbe. Only L0/L1 are baked; the L2 band is
   * cleared so a probe is never left holding a previous position's values.
   */
  applyTo(lightProbe, x, y, z, intensity = 1) {
    const sh = this.sample(x, y, z, this._acc);
    const coefficients = lightProbe.sh.coefficients;
    for (let b = 0; b < 4; b++) {
      coefficients[b].set(sh[b * 3], sh[b * 3 + 1], sh[b * 3 + 2]).multiplyScalar(intensity);
    }
    for (let b = 4; b < coefficients.length; b++) coefficients[b].set(0, 0, 0);
    return lightProbe;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --------------------------- per-object probes ------------------------------
//
// THREE.LightProbe is scene-wide, so a scene-level probe cannot light an enemy
// below decks differently from one on the open deck. These helpers give an
// object its own SH term by patching its materials.
//
// The uniform carries the *difference* between the object's local probe and
// the scene probe, not the local value: the scene probe already contributes to
// every lit surface, so adding the delta lands on the local value exactly
// without double-counting.

// Same magic numbers as THREE's shGetIrradianceAt, restricted to L0+L1.
const SH_C0 = 0.886227;
const SH_C1 = 2.0 * 0.511664;

// Defined once at module scope: THREE keys its program cache on the source of
// onBeforeCompile, so sharing one function keeps every patched material on a
// single compiled program.
function injectProbeUniform(shader) {
  shader.uniforms.probeDeltaSH = this.userData.probeDeltaSH;
  shader.fragmentShader = shader.fragmentShader
    .replace(
      'void main() {',
      `uniform vec3 probeDeltaSH[4];
void main() {`,
    )
    .replace(
      '#include <lights_fragment_begin>',
      `#include <lights_fragment_begin>
      {
        // local probe minus the scene probe, evaluated for this normal
        irradiance += probeDeltaSH[0] * ${SH_C0.toFixed(6)}
          + probeDeltaSH[1] * ${SH_C1.toFixed(6)} * normal.y
          + probeDeltaSH[2] * ${SH_C1.toFixed(6)} * normal.z
          + probeDeltaSH[3] * ${SH_C1.toFixed(6)} * normal.x;
      }`,
    );
}

function patchMaterial(material, uniform) {
  // Materials are shared between enemies (the body atlas), so each object needs
  // its own clone to carry its own uniform. The clone shares textures and
  // compiles to the same program, so this costs a uniform block, not a shader.
  const clone = material.clone();
  clone.userData = { ...clone.userData, probeDeltaSH: uniform };
  clone.onBeforeCompile = injectProbeUniform;
  clone.needsUpdate = true;
  return clone;
}

/**
 * Give an object subtree its own probe term.
 * Returns a handle whose update(volume, sceneSH, intensity) refreshes it.
 */
export function attachObjectProbe(root) {
  const uniform = {
    value: [
      new THREE.Vector3(), new THREE.Vector3(),
      new THREE.Vector3(), new THREE.Vector3(),
    ],
  };
  let patched = 0;
  root.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    // Invisible hitbox proxies use MeshBasicMaterial, which is unlit; patching
    // it would fail to compile because it has no irradiance to add to.
    const patch = (m) => (m && m.isMeshBasicMaterial ? m : (patched++, patchMaterial(m, uniform)));
    object.material = Array.isArray(object.material)
      ? object.material.map(patch)
      : patch(object.material);
  });
  const local = new Float32Array(12);
  return {
    uniform,
    materialCount: patched,
    /** Sample `volume` at `position` and store the delta against `sceneSH`. */
    update(volume, position, sceneSH, intensity = 1) {
      if (!volume) return;
      volume.sample(position.x, position.y, position.z, local);
      for (let b = 0; b < 4; b++) {
        uniform.value[b].set(
          local[b * 3] * intensity - sceneSH[b * 3],
          local[b * 3 + 1] * intensity - sceneSH[b * 3 + 1],
          local[b * 3 + 2] * intensity - sceneSH[b * 3 + 2],
        );
      }
    },
  };
}

export async function loadProbeVolume(baseUrl = '') {
  const [layout, buffer] = await Promise.all([
    fetch(`${baseUrl}hijacked_probes.json`).then((r) => {
      if (!r.ok) throw new Error(`probe layout HTTP ${r.status}`);
      return r.json();
    }),
    fetch(`${baseUrl}hijacked_probes.bin`).then((r) => {
      if (!r.ok) throw new Error(`probe data HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return new ProbeVolume(layout, new Float32Array(buffer));
}
