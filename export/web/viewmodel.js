import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createMuzzleFlashTexture } from './weapon-effects.js';
import { parseNotetracks, NotetrackTimeline } from './notetracks.js';

// The exported viewhands skeleton keeps the engine's view axes in tag_view's
// local space: X forward (down the barrel), Y left, Z up. This basis maps that
// onto the three.js camera convention (X right, Y up, -Z forward).
const VIEW_TO_CAMERA = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
);

const { clamp, damp } = THREE.MathUtils;

const CUSTOM_CAMO_URL = './images/openai-camo.png';
const CAMO_MATERIAL_PATTERN = /_camo\d*$/i;

function findNode(root, name) {
  let found = null;
  root.traverse((object) => {
    if (!found && object.name === name) found = object;
  });
  return found;
}

function applyCustomCamo(root, texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.needsUpdate = true;

  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!CAMO_MATERIAL_PATTERN.test(material.name)) continue;
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    }
  });
}

export class Viewmodel {
  constructor({ fov = 75, adsFov = 55, adsDistance = 7 } = {}) {
    this.baseFov = fov;
    this.adsFov = adsFov;
    this.adsDistance = adsDistance;

    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.5, 500);
    this.scene = new THREE.Scene();

    // Levels assume the renderer's ACES tone mapping and the vision set's
    // exposure (see lighting.js). setEnvironment() supplies ambient/specular
    // from the map's reflection probe; these two only shape the weapon.
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a4a55, 0.32);
    this.scene.add(this.hemi);
    const lamp = new THREE.DirectionalLight(0xfff2d8, 0.65);
    lamp.position.set(-2, 3, 1.5);
    this.scene.add(lamp);
    this.lamp = lamp;

    // adsGroup carries the aim translation, swayGroup the idle/motion offsets,
    // and root the fixed rig placement (tag_view anchored to the camera).
    this.adsGroup = new THREE.Group();
    this.swayGroup = new THREE.Group();
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = false;
    this.swayGroup.add(this.root);
    this.adsGroup.add(this.swayGroup);
    this.scene.add(this.adsGroup);

    this.ready = false;
    this.aiming = false;
    this.aimBlend = 0;
    this.sprintBlend = 0;
    this.bobTime = 0;
    this.bobAmp = 0;
    this.pendingLook = new THREE.Vector2();
    this.lookVel = new THREE.Vector2();
    this.swayRot = new THREE.Vector2();
    this.swayPos = new THREE.Vector2();
    this.adsOffset = new THREE.Vector3();
    this.adsMatrix = new THREE.Matrix4();
    this.adsPos = new THREE.Vector3();
    this.adsQuat = new THREE.Quaternion();
    this.adsScale = new THREE.Vector3(1, 1, 1);
    this.identityQuat = new THREE.Quaternion();
    this.tagFlash = null;
    this.muzzleFlash = null;
    this.muzzleLight = null;
    this.flashTime = 0;

    this.mixer = null;
    this.clips = new Map();
    // Cues authored into the clips. onNotetrack receives {type, name, time} as
    // each one passes; index.html routes the sound cues to the audio engine.
    this.notetracks = new Map();
    this.onNotetrack = null;
    this.activeTimeline = null;
    this.notetrackAction = null;
    this.idleAction = null;
    this.reloadAction = null;
    this.reloadEmptyAction = null;
    this.fireAction = null;
    this.adsFireAction = null;
    this.reloading = false;
  }

  async load(handsUrl, weaponUrl, magazineUrl, onProgress) {
    // The exported GLBs reference sibling textures as .dds; the web export
    // ships texconv PNG copies instead, so remap the suffix at load time.
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => (url.endsWith('.dds') ? `${url.slice(0, -4)}.png` : url));
    const loader = new GLTFLoader(manager);
    const textureLoader = new THREE.TextureLoader(manager);
    const load = (url, label) => loader.loadAsync(url, (event) => onProgress?.(label, event));
    const [hands, weapon, magazine, customCamo] = await Promise.all([
      load(handsUrl, 'hands'),
      load(weaponUrl, 'weapon'),
      magazineUrl
        ? load(magazineUrl, 'magazine').catch((error) => {
          console.warn('Magazine attachment unavailable:', error);
          return null;
        })
        : Promise.resolve(null),
      textureLoader.loadAsync(CUSTOM_CAMO_URL),
    ]);

    applyCustomCamo(weapon.scene, customCamo);
    if (magazine) applyCustomCamo(magazine.scene, customCamo);

    this.root.add(hands.scene, weapon.scene);
    // T6 ships the magazine as its own attachment xmodel rather than welding it
    // into the receiver, because the reload xanim animates it out of the well
    // and back in on a `tag_clip` track. Parenting it into the weapon's own
    // space lands it in the magwell and lets that authored track bind by name.
    if (magazine) weapon.scene.add(magazine.scene);
    this.root.updateMatrixWorld(true);

    // T6 mount convention: the weapon's j_gun joint lands exactly on the
    // hands' tag_weapon joint. Parent the weapon under tag_weapon (weld =
    // j_gun's inverse bind world matrix) so animated hand motion such as the
    // reload carries the gun along.
    const tagWeapon = findNode(hands.scene, 'tag_weapon');
    const jGun = findNode(weapon.scene, 'j_gun');
    const tagView = findNode(hands.scene, 'tag_view');
    if (!tagWeapon || !jGun || !tagView) {
      throw new Error('viewmodel joints not found in exported rigs');
    }
    weapon.scene.matrixAutoUpdate = false;
    weapon.scene.matrix.copy(jGun.matrixWorld).invert();
    tagWeapon.add(weapon.scene);

    // Anchor tag_view at the camera origin so the authored hip pose shows.
    this.root.updateMatrixWorld(true);
    this.root.matrix.multiplyMatrices(VIEW_TO_CAMERA, tagView.matrixWorld.clone().invert());
    this.root.updateMatrixWorld(true);
    this.computeAdsAlignment();
    this.tagFlash = findNode(weapon.scene, 'tag_flash');
    this.createMuzzleFlash();

    this.root.traverse((object) => {
      object.frustumCulled = false;
      if (object.isMesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });

    this.ready = true;
  }

  // Share the world's prefiltered environment so the weapon picks up the same
  // sky/probe reflections the map does. Intensity is kept a little under the
  // world's because the viewmodel sits in its own overlay scene with no
  // surrounding geometry to occlude it.
  setEnvironment(texture, intensity = 0.5) {
    this.scene.environment = texture;
    this.scene.environmentIntensity = intensity;
  }

  createMuzzleFlash() {
    if (!this.tagFlash) return;
    const material = new THREE.SpriteMaterial({
      map: createMuzzleFlashTexture(),
      color: 0xffd27a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.muzzleFlash = new THREE.Sprite(material);
    this.muzzleFlash.scale.set(8, 8, 1);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.renderOrder = 100;
    this.muzzleLight = new THREE.PointLight(0xffa43b, 0, 25, 2);
    this.tagFlash.add(this.muzzleFlash, this.muzzleLight);
  }

  // ADS: rotate the rig so the gun points straight down the view axis
  // (squaring up the sight picture) and put tag_sights on that axis.
  computeAdsAlignment() {
    const jGun = findNode(this.root, 'j_gun');
    const tagSights = findNode(this.root, 'tag_sights');
    if (!tagSights || !jGun) return;
    const sight = tagSights.getWorldPosition(new THREE.Vector3());
    const gunQuat = jGun.getWorldQuaternion(new THREE.Quaternion());
    const gunFwd = new THREE.Vector3(1, 0, 0).applyQuaternion(gunQuat).normalize();
    const gunUp = new THREE.Vector3(0, 0, 1).applyQuaternion(gunQuat).normalize();

    // Camera back/up expressed against the gun frame, orthonormalized.
    const zAxis = gunFwd.clone().negate();
    const yAxis = gunUp.clone().addScaledVector(zAxis, -gunUp.dot(zAxis)).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    const camToGun = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);

    this.adsMatrix
      .multiplyMatrices(new THREE.Matrix4().makeTranslation(0, 0, -this.adsDistance), camToGun)
      .multiply(new THREE.Matrix4().makeTranslation(-sight.x, -sight.y, -sight.z));
    this.adsMatrix.decompose(this.adsPos, this.adsQuat, this.adsScale);
  }

  // Loads xanim-derived JSON clips (see .tools/xanim_to_json.mjs) and turns
  // them into AnimationClips bound to the rig by bone name. The idle clip is
  // the authored hip-fire pose, so it becomes the always-on base layer the
  // reload crossfades against; the GLB bind pose only shows before it starts.
  async loadClips(entries) {
    const pending = Object.entries(entries).map(async ([key, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`clip ${key} HTTP ${response.status}`);
      return [key, await response.json()];
    });
    const loaded = await Promise.all(pending);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.mixer.addEventListener('finished', (event) => this.onClipFinished(event));

    for (const [key, data] of loaded) {
      const tracks = [];
      for (const bone of data.bones) {
        const node = findNode(this.root, bone.name);
        if (!node) continue;
        if (bone.rot?.values?.length) {
          const times = bone.rot.frames.map((frame) => frame / data.fps);
          const values = bone.rot.values.slice();
          // tag_clip's rotation is authored in the source animation scene just
          // like its position: the track opens on identity while the magazine
          // binds at -90 degrees about X, so playing it raw rolls the magazine
          // onto its side. Re-anchor the channel on the bind orientation and
          // keep the motion the clip actually describes.
          if (bone.name === 'tag_clip') {
            const correction = node.quaternion.clone()
              .multiply(new THREE.Quaternion(values[0], values[1], values[2], values[3]).invert());
            const key = new THREE.Quaternion();
            for (let i = 0; i < values.length; i += 4) {
              key.set(values[i], values[i + 1], values[i + 2], values[i + 3]).premultiply(correction);
              values[i] = key.x;
              values[i + 1] = key.y;
              values[i + 2] = key.z;
              values[i + 3] = key.w;
            }
          }
          tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
        }
        if (bone.pos?.values?.length) {
          const times = bone.pos.frames.map((frame) => frame / data.fps);
          const values = bone.pos.values.slice();
          // The magazine's tag_clip track carries a constant 163-unit placement
          // that belongs to the source animation scene, not to this rig, the
          // same way the body xanims place j_mainroot (see enemy-system.js).
          // Applied as authored it throws the magazine out of the world, so
          // rebase it onto the attachment's own bind position in the magwell.
          if (bone.name === 'tag_clip') {
            const offset = [
              node.position.x - values[0],
              node.position.y - values[1],
              node.position.z - values[2],
            ];
            for (let i = 0; i < values.length; i += 3) {
              values[i] += offset[0];
              values[i + 1] += offset[1];
              values[i + 2] += offset[2];
            }
          }
          tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, values));
        }
      }
      this.clips.set(key, new THREE.AnimationClip(key, data.duration, tracks));
      this.notetracks.set(key, parseNotetracks(data.notifies));
    }

    if (this.clips.has('idle')) {
      this.idleAction = this.mixer.clipAction(this.clips.get('idle'));
      this.idleAction.setLoop(THREE.LoopOnce, 1);
      this.idleAction.clampWhenFinished = true;
      this.idleAction.play();
      this.mixer.update(0);
      this.root.updateMatrixWorld(true);
      // The sight alignment must match the pose the rig actually holds.
      this.computeAdsAlignment();
    }

    if (this.clips.has('reload') && this.idleAction) {
      this.reloadAction = this.mixer.clipAction(this.clips.get('reload'));
      this.reloadAction.setLoop(THREE.LoopOnce, 1);
      this.reloadAction.clampWhenFinished = true;
    }
    if (this.clips.has('reloadEmpty') && this.idleAction) {
      this.reloadEmptyAction = this.mixer.clipAction(this.clips.get('reloadEmpty'));
      this.reloadEmptyAction.setLoop(THREE.LoopOnce, 1);
      this.reloadEmptyAction.clampWhenFinished = true;
    }
    if (this.clips.has('fire') && this.idleAction) {
      this.fireAction = this.mixer.clipAction(this.clips.get('fire'));
      this.fireAction.setLoop(THREE.LoopOnce, 1);
    }
    if (this.clips.has('adsFire') && this.idleAction) {
      this.adsFireAction = this.mixer.clipAction(this.clips.get('adsFire'));
      this.adsFireAction.setLoop(THREE.LoopOnce, 1);
    }
  }

  onClipFinished(event) {
    if (event.action === this.reloadAction || event.action === this.reloadEmptyAction) {
      this.reloading = false;
      this.stopNotetracks();
      this.idleAction.reset().fadeIn(0.12).play();
      event.action.fadeOut(0.12);
      return;
    }
    if (event.action === this.fireAction || event.action === this.adsFireAction) {
      event.action.stop();
      if (!this.reloading) this.idleAction.reset().fadeIn(0.06).play();
    }
  }

  reload(empty = false) {
    const action = empty && this.reloadEmptyAction ? this.reloadEmptyAction : this.reloadAction;
    if (!this.ready || !action || this.reloading) return false;
    this.reloading = true;
    this.fireAction?.stop();
    this.adsFireAction?.stop();
    action.reset().fadeIn(0.12).play();
    this.idleAction.fadeOut(0.12);
    this.startNotetracks(empty && this.reloadEmptyAction ? 'reloadEmpty' : 'reload', action);
    return true;
  }

  startNotetracks(clipKey, action) {
    const events = this.notetracks.get(clipKey) ?? [];
    this.notetrackAction = action;
    this.activeTimeline = events.length ? new NotetrackTimeline(events) : null;
  }

  stopNotetracks() {
    this.activeTimeline = null;
    this.notetrackAction = null;
  }

  fire() {
    if (!this.ready || this.reloading) return false;
    const action = this.aimBlend > 0.5 && this.adsFireAction ? this.adsFireAction : this.fireAction;
    if (action) {
      const other = action === this.fireAction ? this.adsFireAction : this.fireAction;
      other?.stop();
      this.idleAction?.fadeOut(0.02);
      action.reset().setEffectiveWeight(1).fadeIn(0.005).play();
    }
    this.flashTime = 0.045;
    if (this.muzzleFlash) {
      this.muzzleFlash.material.rotation = Math.random() * Math.PI;
      this.muzzleFlash.material.opacity = 1;
      this.muzzleFlash.visible = true;
    }
    if (this.muzzleLight) this.muzzleLight.intensity = 7;
    return true;
  }

  setAiming(aiming) {
    this.aiming = Boolean(aiming);
  }

  addLook(dx, dy) {
    this.pendingLook.x += dx;
    this.pendingLook.y += dy;
  }

  setSize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  muzzlePosition(target = new THREE.Vector3()) {
    if (!this.ready || !this.tagFlash) return null;
    this.scene.updateMatrixWorld(true);
    return this.tagFlash.getWorldPosition(target);
  }

  update(dt, state = {}) {
    if (!this.ready) return;
    this.mixer?.update(dt);
    if (this.activeTimeline && this.notetrackAction) {
      for (const cue of this.activeTimeline.advance(this.notetrackAction.time)) {
        this.onNotetrack?.(cue);
      }
    }
    this.flashTime = Math.max(0, this.flashTime - dt);
    if (this.muzzleFlash) {
      const flash = clamp(this.flashTime / 0.045, 0, 1);
      this.muzzleFlash.visible = flash > 0;
      this.muzzleFlash.material.opacity = flash;
      this.muzzleFlash.scale.setScalar(6 + flash * 4);
      this.muzzleLight.intensity = flash * 7;
    }
    const speed = state.speed ?? 0;
    const grounded = state.grounded ?? true;
    const moving = Boolean(state.moving);
    const sprinting = Boolean(state.sprinting) && moving;

    // Smoothed look velocity drives the weapon lag (sway) behind the camera.
    const safeDt = Math.max(dt, 1e-4);
    this.lookVel.x = damp(this.lookVel.x, this.pendingLook.x / safeDt, 10, dt);
    this.lookVel.y = damp(this.lookVel.y, this.pendingLook.y / safeDt, 10, dt);
    this.pendingLook.set(0, 0);
    this.swayRot.x = damp(this.swayRot.x, clamp(-this.lookVel.y * 0.00035, -0.26, 0.26), 12, dt);
    this.swayRot.y = damp(this.swayRot.y, clamp(-this.lookVel.x * 0.00035, -0.3, 0.3), 12, dt);
    this.swayPos.x = damp(this.swayPos.x, clamp(-this.lookVel.x * 0.004, -1.2, 1.2), 10, dt);
    this.swayPos.y = damp(this.swayPos.y, clamp(this.lookVel.y * 0.004, -1.2, 1.2), 10, dt);

    // Walk bob: figure-eight drift scaled by ground speed.
    const movingGrounded = moving && grounded;
    const speedFactor = clamp(speed / 300, 0, 1.4);
    this.bobAmp = damp(this.bobAmp, movingGrounded ? speedFactor : 0, 8, dt);
    if (movingGrounded) this.bobTime += dt * (5.5 + 4 * speedFactor);
    const bobX = Math.sin(this.bobTime) * 0.85 * this.bobAmp;
    const bobY = Math.sin(this.bobTime * 2) * 0.45 * this.bobAmp;

    this.sprintBlend = damp(
      this.sprintBlend,
      sprinting && !this.aiming && !this.reloading ? 1 : 0,
      8,
      dt,
    );
    // Reloading cancels the sight picture, as in the game.
    this.aimBlend = damp(this.aimBlend, this.aiming && !this.reloading ? 1 : 0, 12, dt);

    const aimScale = 1 - this.aimBlend * 0.88;
    const sprint = this.sprintBlend;
    this.swayGroup.rotation.set(
      this.swayRot.x * aimScale + 0.3 * sprint,
      this.swayRot.y * aimScale + 0.42 * sprint,
      this.swayRot.y * -0.4 * aimScale - 0.28 * sprint,
    );
    this.swayGroup.position.set(
      this.swayPos.x * aimScale + bobX * aimScale,
      this.swayPos.y * aimScale + bobY * aimScale + 0.8 * sprint,
      0,
    );

    this.adsGroup.position.copy(this.adsPos).multiplyScalar(this.aimBlend);
    if (this.aimBlend > 0) {
      this.adsGroup.quaternion.slerpQuaternions(this.identityQuat, this.adsQuat, this.aimBlend);
    } else {
      this.adsGroup.quaternion.identity();
    }
    this.camera.fov = this.baseFov + (this.adsFov - this.baseFov) * this.aimBlend;
    this.camera.updateProjectionMatrix();
  }

  render(renderer) {
    if (!this.ready) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
