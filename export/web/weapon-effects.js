import * as THREE from 'three';

const center = new THREE.Vector2(0, 0);
const surfaceNormal = new THREE.Vector3();
const planeNormal = new THREE.Vector3(0, 0, 1);
const _listenerPosition = new THREE.Vector3();
const _listenerForward = new THREE.Vector3();
const _listenerUp = new THREE.Vector3();

// World units are Radiant inches: the capsule is 72 tall and walks at 300/s.
// Every panner distance below is tuned against that scale, not metres.
const PANNER_REFERENCE_DISTANCE = 180;

let flashTexture = null;

// The reload xanim names its audio cues by alias, but the shipped soundbanks
// key entries by a 32-bit hash with no name table, and the alias-to-file map
// lives in a common bank this export does not include. These files were
// recovered structurally instead: the five HK416 mechanical sounds are the
// contiguous run of mono entries that follows the M27's stereo shot cluster in
// cmn_root.all.sabl, taken in the bank's own order.
//
// UNVERIFIED: the run is the right one, but which entry is which cue is
// inferred, not confirmed by ear. To correct one, swap its filename here --
// nothing else reads these names.
export const FOLEY_URLS = {
  fly_hk416_bolt_back: './audio/fly_hk416_bolt_back.wav',
  fly_hk416_bolt_release: './audio/fly_hk416_bolt_release.wav',
  fly_hk416_futz: './audio/fly_hk416_futz.wav',
  fly_hk416_mag_in: './audio/fly_hk416_mag_in.wav',
  fly_hk416_mag_out: './audio/fly_hk416_mag_out.wav',
  fly_reload_cloth_sm: './audio/fly_reload_cloth_sm.wav',
};

// A soft radial core crossed by two thin spikes. Shared by the viewmodel's
// first-person flash and the world flashes fired by enemies so both weapons
// read as the same muzzle.
export function createMuzzleFlashTexture() {
  if (flashTexture) return flashTexture;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const radial = Math.exp(-(nx * nx + ny * ny) * 7);
      const cross = Math.exp(-Math.abs(nx) * 18) * Math.exp(-ny * ny * 2)
        + Math.exp(-Math.abs(ny) * 18) * Math.exp(-nx * nx * 2);
      const alpha = THREE.MathUtils.clamp(radial + cross * 0.55, 0, 1);
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 214;
      data[offset + 2] = 112;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  flashTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  flashTexture.colorSpace = THREE.SRGBColorSpace;
  flashTexture.needsUpdate = true;
  return flashTexture;
}

function setAudioPosition(target, x, y, z) {
  if (target.positionX) {
    target.positionX.value = x;
    target.positionY.value = y;
    target.positionZ.value = z;
  } else {
    target.setPosition(x, y, z);
  }
}

export class GunAudio {
  constructor({
    shotUrl = './audio/wpn_m27_shot_plr.wav',
    exteriorDecayUrl = './audio/wpn_assault_decay_ext.wav',
    interiorDecayUrl = './audio/wpn_assault_decay_int.wav',
    lfeUrl = './audio/wpn_mp7_fire_lfe.wav',
  } = {}) {
    this.context = null;
    this.output = null;
    this.uiOutput = null;
    this.ready = false;
    this.loading = null;
    this.buffers = Object.create(null);
    this.foleyBuffers = Object.create(null);
    this.voices = Object.create(null);
    this.panners = new Map();
    this.listenerPosition = new THREE.Vector3();
    this.urls = {
      shot: shotUrl,
      exteriorDecay: exteriorDecayUrl,
      interiorDecay: interiorDecayUrl,
      lfe: lfeUrl,
    };
  }

  ensureContext() {
    const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContext) return null;
    if (!this.context) {
      this.context = new AudioContext();
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -5;
      compressor.knee.value = 6;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.08;
      const master = this.context.createGain();
      master.gain.value = 0.68;
      master.connect(compressor).connect(this.context.destination);
      this.output = master;

      // Hitmarkers bypass the gunfire compressor. Routed through it, every
      // confirmation tick would be ducked by the shot that caused it.
      const ui = this.context.createGain();
      ui.gain.value = 0.5;
      ui.connect(this.context.destination);
      this.uiOutput = ui;
    }
    return this.context;
  }

  async load() {
    if (this.ready) return true;
    if (this.loading) return this.loading;
    const context = this.ensureContext();
    if (!context) return false;
    const decode = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`weapon audio HTTP ${response.status}: ${url}`);
      return context.decodeAudioData(await response.arrayBuffer());
    };

    // Reload foley is loaded tolerantly: a missing or undecodable cue should
    // cost that one layer, not the gunfire the weapon depends on.
    const foley = Promise.allSettled(
      Object.entries(FOLEY_URLS).map(async ([name, url]) => {
        this.foleyBuffers[name] = await decode(url);
      }),
    ).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) console.warn(`${failed.length} reload foley cue(s) unavailable`, failed[0].reason);
    });

    this.loading = Promise.all([
      ...Object.entries(this.urls).map(async ([name, url]) => {
        this.buffers[name] = await decode(url);
      }),
      foley,
    ]).then(() => {
      this.ready = true;
      return true;
    });
    return this.loading;
  }

  // Weapon handling foley is the player's own gun: dry and centered, never
  // panned, so it sits in the head the way the viewmodel does on screen.
  playFoley(name, { gain = 0.85 } = {}) {
    const context = this.ensureContext();
    const buffer = this.foleyBuffers[name];
    if (!context || !buffer || !this.output) return false;
    if (context.state === 'suspended') void context.resume();

    const source = context.createBufferSource();
    const gainNode = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** (((Math.random() * 30) - 15) / 1200);
    gainNode.gain.value = gain;
    source.connect(gainNode).connect(this.output);
    source.onended = () => {
      source.disconnect();
      gainNode.disconnect();
    };
    source.start();
    return true;
  }

  // Keeps the Web Audio listener on the camera so panned shots stay locked to
  // the world while the player turns.
  setListener(camera) {
    const context = this.context;
    if (!context || !camera) return;
    const listener = context.listener;
    camera.getWorldPosition(_listenerPosition);
    camera.getWorldDirection(_listenerForward);
    _listenerUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.listenerPosition.copy(_listenerPosition);

    if (listener.positionX) {
      setAudioPosition(listener, _listenerPosition.x, _listenerPosition.y, _listenerPosition.z);
      listener.forwardX.value = _listenerForward.x;
      listener.forwardY.value = _listenerForward.y;
      listener.forwardZ.value = _listenerForward.z;
      listener.upX.value = _listenerUp.x;
      listener.upY.value = _listenerUp.y;
      listener.upZ.value = _listenerUp.z;
    } else {
      listener.setPosition(_listenerPosition.x, _listenerPosition.y, _listenerPosition.z);
      listener.setOrientation(
        _listenerForward.x, _listenerForward.y, _listenerForward.z,
        _listenerUp.x, _listenerUp.y, _listenerUp.z,
      );
    }
  }

  // One persistent panner per source key (an enemy index). Reusing them avoids
  // allocating and tearing down an HRTF node on every shot of a burst.
  pannerFor(key, position) {
    const context = this.ensureContext();
    if (!context) return null;
    let panner = this.panners.get(key);
    if (!panner) {
      panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = PANNER_REFERENCE_DISTANCE;
      panner.maxDistance = 9000;
      panner.rolloffFactor = 0.9;
      panner.connect(this.output);
      this.panners.set(key, panner);
    }
    setAudioPosition(panner, position.x, position.y, position.z);
    return panner;
  }

  playLayer(name, gainValue, voiceLimit, { destination = null, lowpassHz = 0 } = {}) {
    const context = this.context;
    const buffer = this.buffers[name];
    if (!context || !buffer) return;

    const voices = this.voices[name] ?? (this.voices[name] = []);
    if (voices.length >= voiceLimit) {
      const oldest = voices.shift();
      try { oldest.stop(); } catch { /* already ended */ }
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    // The original alias varies each layer by up to 25 cents per shot.
    source.playbackRate.value = 2 ** (((Math.random() * 50) - 25) / 1200);
    gain.gain.value = gainValue;

    const chain = [source];
    if (lowpassHz > 0) {
      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = lowpassHz;
      chain.push(lowpass);
    }
    chain.push(gain);
    for (let i = 0; i < chain.length - 1; i += 1) chain[i].connect(chain[i + 1]);
    gain.connect(destination ?? this.output);

    voices.push(source);
    source.onended = () => {
      const index = voices.indexOf(source);
      if (index >= 0) voices.splice(index, 1);
      for (const node of chain) node.disconnect();
    };
    source.start();
  }

  play({ indoors = false } = {}) {
    const context = this.ensureContext();
    if (!context) return;
    if (context.state === 'suspended') void context.resume();
    if (!this.ready) {
      void this.load();
      return;
    }

    this.playLayer('shot', 1, 3);
    this.playLayer('lfe', 0.45, 8);
    this.playLayer(indoors ? 'interiorDecay' : 'exteriorDecay', 0.32, 3);
  }

  // The export ships only the player-perspective M27 alias, so the NPC report
  // is derived from it: panned to the shooter, and rolled off with distance
  // the way air absorption removes the crack before the body of the shot.
  playShotAt(position, { key = 0, indoors = false } = {}) {
    const context = this.ensureContext();
    if (!context || !position) return;
    if (context.state === 'suspended') void context.resume();
    if (!this.ready) {
      void this.load();
      return;
    }
    const panner = this.pannerFor(key, position);
    if (!panner) return;

    const distance = this.listenerPosition.distanceTo(position);
    const lowpassHz = 1200 + 18000 / (1 + distance / 600);
    this.playLayer('shot', 1.5, 6, { destination: panner, lowpassHz });
    this.playLayer(indoors ? 'interiorDecay' : 'exteriorDecay', 0.5, 6, {
      destination: panner,
      lowpassHz: lowpassHz * 0.75,
    });
  }

  // Synthesized rather than sampled: the extracted banks carry no UI alias,
  // and a short swept tick is what the confirmation needs to cut through
  // gunfire without competing with it.
  playTick({ frequency = 1650, duration = 0.05, gainValue = 0.55, delay = 0 } = {}) {
    const context = this.ensureContext();
    if (!context || !this.uiOutput) return;
    if (context.state === 'suspended') void context.resume();

    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.55, start + duration);

    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain).connect(this.uiOutput);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }

  playHitmarker({ region = 'torso', killed = false } = {}) {
    if (killed) {
      this.playTick({ frequency: 1500, duration: 0.06, gainValue: 0.6 });
      this.playTick({ frequency: 1000, duration: 0.11, gainValue: 0.6, delay: 0.055 });
      return;
    }
    if (region === 'head') {
      this.playTick({ frequency: 2350, duration: 0.055, gainValue: 0.6 });
      return;
    }
    this.playTick({ frequency: 1650, duration: 0.045, gainValue: 0.45 });
  }
}

export class WeaponEffects {
  constructor(scene, { maxDistance = 10000, maxImpacts = 96, maxFlashes = 12 } = {}) {
    this.scene = scene;
    this.maxDistance = maxDistance;
    this.maxImpacts = maxImpacts;
    this.raycaster = new THREE.Raycaster();
    this.ceilingRaycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.ceilingRaycaster.firstHitOnly = true;
    this.audio = new GunAudio();
    this.impacts = [];
    this.transients = [];
    this.shotCount = 0;
    this.lastHit = null;
    this.lastIndoors = false;

    // World muzzle flashes are pooled and created up front so they take part
    // in the load-time shader precompile. They are deliberately unlit sprites:
    // adding a PointLight per shot would recompile every material it touches.
    this.flashCursor = 0;
    this.flashes = Array.from({ length: maxFlashes }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createMuzzleFlashTexture(),
        color: 0xffd27a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      sprite.scale.setScalar(16);
      sprite.renderOrder = 35;
      sprite.visible = false;
      sprite.frustumCulled = false;
      scene.add(sprite);
      return { sprite, life: 0, maxLife: 0.05 };
    });
  }

  loadAudio() {
    return this.audio.load();
  }

  updateListener(camera) {
    this.audio.setListener(camera);
  }

  isIndoors(camera, collisionRoot) {
    if (!collisionRoot) return false;
    this.ceilingRaycaster.set(camera.getWorldPosition(surfaceNormal), new THREE.Vector3(0, 1, 0));
    this.ceilingRaycaster.near = 4;
    this.ceilingRaycaster.far = 240;
    return this.ceilingRaycaster.intersectObject(collisionRoot, true).length > 0;
  }

  fire(camera, collisionRoot, muzzleCameraPosition = null, { targets = [] } = {}) {
    this.lastIndoors = this.isIndoors(camera, collisionRoot);
    this.audio.play({ indoors: this.lastIndoors });
    this.shotCount += 1;
    this.raycaster.setFromCamera(center, camera);
    this.raycaster.near = 0;
    this.raycaster.far = this.maxDistance;
    const roots = [collisionRoot, ...targets].filter(Boolean);
    const hit = roots.length
      ? this.raycaster.intersectObjects(roots, true)[0] ?? null
      : null;
    this.lastHit = hit;

    const end = hit
      ? hit.point.clone()
      : this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, this.maxDistance);
    const start = muzzleCameraPosition
      ? camera.localToWorld(muzzleCameraPosition.clone())
      : this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, 12);
    this.addTracer(start, end);
    if (hit?.object?.userData?.enemyHit) this.addFleshImpact(hit);
    else if (hit) this.addImpact(hit);
    return hit;
  }

  // Enemy report. The player's own indoor test is reused rather than casting
  // again: every shooter is aboard the same yacht as the listener.
  playEnemyShot(position, key = 0) {
    this.audio.playShotAt(position, { key, indoors: this.lastIndoors });
  }

  playHitmarker(info) {
    this.audio.playHitmarker(info);
  }

  playFoley(name) {
    return this.audio.playFoley(name);
  }

  addMuzzleFlash(position, direction = null) {
    const flash = this.flashes[this.flashCursor];
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    flash.sprite.position.copy(position);
    if (direction) flash.sprite.position.addScaledVector(direction, 3);
    flash.sprite.material.rotation = Math.random() * Math.PI;
    flash.sprite.material.opacity = 1;
    // Sized so the flash still reads as a point of origin at the far end of
    // the enemy attack range, where it is the only cue to a shooter's bearing.
    flash.sprite.scale.setScalar(19 + Math.random() * 6);
    flash.sprite.visible = true;
    flash.life = flash.maxLife;
  }

  addTracer(start, end) {
    const material = new THREE.LineBasicMaterial({
      color: 0xffe6a0,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 25;
    this.scene.add(line);
    this.transients.push({ object: line, life: 0.055, maxLife: 0.055 });
  }

  addImpact(hit) {
    surfaceNormal.copy(hit.face?.normal ?? planeNormal).transformDirection(hit.object.matrixWorld).normalize();

    const geometry = new THREE.CircleGeometry(1.35, 10);
    const material = new THREE.MeshBasicMaterial({
      color: 0x16120f,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const mark = new THREE.Mesh(geometry, material);
    mark.position.copy(hit.point).addScaledVector(surfaceNormal, 0.08);
    mark.quaternion.setFromUnitVectors(planeNormal, surfaceNormal);
    mark.scale.setScalar(0.75 + Math.random() * 0.5);
    mark.renderOrder = 20;
    this.scene.add(mark);
    this.impacts.push(mark);

    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 5, 3),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    spark.position.copy(hit.point).addScaledVector(surfaceNormal, 0.5);
    spark.renderOrder = 30;
    this.scene.add(spark);
    this.transients.push({ object: spark, life: 0.065, maxLife: 0.065 });

    while (this.impacts.length > this.maxImpacts) this.disposeObject(this.impacts.shift());
  }

  addFleshImpact(hit) {
    const burst = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0x8f1010, transparent: true, opacity: 0.9 }),
    );
    burst.position.copy(hit.point);
    burst.renderOrder = 30;
    this.scene.add(burst);
    this.transients.push({ object: burst, life: 0.11, maxLife: 0.11 });
  }

  update(dt) {
    for (let i = this.transients.length - 1; i >= 0; i -= 1) {
      const transient = this.transients[i];
      transient.life -= dt;
      const material = transient.object.material;
      if (material && 'opacity' in material) material.opacity = Math.max(0, transient.life / transient.maxLife);
      if (transient.life <= 0) {
        this.disposeObject(transient.object);
        this.transients.splice(i, 1);
      }
    }
    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life = Math.max(0, flash.life - dt);
      const remaining = flash.life / flash.maxLife;
      flash.sprite.material.opacity = remaining;
      flash.sprite.visible = remaining > 0;
    }
  }

  disposeObject(object) {
    object.removeFromParent();
    object.geometry?.dispose();
    object.material?.dispose();
  }
}
