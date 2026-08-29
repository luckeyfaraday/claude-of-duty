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
