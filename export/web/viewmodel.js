import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
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

const CUSTOM_CAMOS = Object.freeze({
  openai: './images/openai-camo.webp',
  claude: './images/claude-camo.webp',
});
const CAMO_MATERIAL_PATTERN = /_camo\d*$/i;
// Names the weapon rigs use for the tag the fresh magazine rides in on. Only
// the rigs that animate two magazines carry one; see mountSpareMagazine().
const SPARE_MAGAZINE_TAGS = Object.freeze(['tag_clip_full', 'tag_clip1']);
// Every magazine channel is authored as a displacement and has to be anchored
// before it can be played; the two halves of a mag change anchor on opposite
// ends of the track. See the rebase in loadClips().
const MAGAZINE_TAGS = Object.freeze(new Set(['tag_clip', ...SPARE_MAGAZINE_TAGS]));
// The cue the clips fire as the empty magazine is released, which is the instant
// the fresh one takes over as the magazine the reload is about; see
// handOverMagazine().
const MAGAZINE_HANDOVER_CUE = /mag_out/;
// The red tritium insert capping the front post is the element the eye lines up
// on, so it defines where the sight picture points, not the tag authored on the
// sight base. See computeAdsAlignment().
const SIGHT_INSERT_PATTERN = /tritium/i;

// The rear sight carries no tag and no material of its own, so it is measured
// off the posed geometry instead: the top of the rear sight, which is the point
// a shooter levels the front post against. Taking the floor of the notch instead
// buries the post behind the sight body — the post tip is authored level with
// that floor, so it grazes it and nothing stands up in the opening. Levelling on
// the top instead drops the rear sight just below centre and frames the front
// sight above it, which is the picture the game itself shows.
// Thresholds are in rig units, about one per inch on the shipped weapons.
const REAR_SIGHT_MIN_RADIUS = 2;
const REAR_SIGHT_PLANE_BAND = 0.35;
// Wide enough to span the rear sight's shoulders, which stand 0.2 either side of
// the centreline on this rig, and still far short of anything else in the band.
const REAR_SIGHT_HALF_WIDTH = 0.5;

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
  // adsEyeRelief is the gap the aiming eye keeps behind the *rear* sight, which
  // is what decides whether the rear sight is in front of the camera at all.
  // adsDistance only applies to rigs with no rear sight to find, where it keeps
  // its old meaning: the distance from the eye to tag_sights/tag_sights_on.
  // A weapon may provide measured ADS anchors as the plain serializable
  // `adsSightAnchors: { front: [x, y, z], rear: [x, y, z] }` option, in j_gun
  // local space. This is for exported rigs whose front sight has no identifiable
  // insert material for findSightTip to measure — saritch, scar and sig556 ship
  // no tritium at all, so the geometry search has nothing to key on.
  // `front` alone is enough: findRearSight works off the post tip, so supplying
  // the front point lets the rear one still come from the geometry. `rear` alone
  // is not — there is no line without a front point, and on these rigs nothing
  // can supply one — so it warns and takes the single-point fallback.
  constructor({
    fov = 75,
    adsFov = 55,
    adsDistance = 7,
    adsEyeRelief = 3.5,
    adsSightAnchors = null,
    camo = 'openai',
  } = {}) {
    this.baseFov = fov;
    this.adsFov = adsFov;
    this.adsDistance = adsDistance;
    this.adsEyeRelief = adsEyeRelief;
    this.adsSightAnchors = adsSightAnchors;

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
    this.introFireAction = null;
    this.introAdsFireAction = null;
    this.reloading = false;
    this.weaponRoot = null;
    this.magazineRoot = null;
    this.spareMagazine = null;
    this.camo = Object.hasOwn(CUSTOM_CAMOS, camo) ? camo : 'openai';
    this.camoTextures = new Map();
    this.camoRoots = [];
  }

  get availableCamos() {
    return Object.keys(CUSTOM_CAMOS);
  }

  setCamo(name) {
    const texture = this.camoTextures.get(name);
    if (!texture) return false;
    for (const root of this.camoRoots) applyCustomCamo(root, texture);
    this.camo = name;
    return true;
  }

  // Reports the camo actually on the gun, not the one asked for: a texture that
  // failed to load leaves setCamo a no-op, and the caller's key binding and the
  // debug state both read this back as the current skin.
  cycleCamo() {
    const names = this.availableCamos;
    const next = names[(names.indexOf(this.camo) + 1) % names.length];
    this.setCamo(next);
    return this.camo;
  }

  // A mag change involves two magazines: the empty one is pulled out and thrown
  // clear, and a fresh one is brought up and seated. T6 animates the empty one
  // on the attachment's own `tag_clip` and the fresh one on a spare tag the
  // *weapon* rig carries, mounting a second copy of the same magazine xmodel
  // there for the length of the reload. Rigs that reuse one magazine for both
  // halves have no spare tag and need none of this; the hk416 is one of them,
  // which is why nothing missed it until the whole roster shipped. Without it
  // the only magazine on the gun is the discarded one, so the fresh magazine is
  // invisible and the hands mime seating nothing — worst on the an94 and sa58,
  // whose empties are thrown 73 and 95 units clear.
  mountSpareMagazine(weaponScene, magazineScene) {
    const tag = SPARE_MAGAZINE_TAGS
      .map((name) => findNode(weaponScene, name))
      .find(Boolean);
    if (!tag) return null;

    const spare = cloneSkinned(magazineScene);
    // The clone carries its own `tag_clip`, and clips bind by name to the first
    // match in the tree. Rename it so it cannot capture the empty magazine's
    // channel: the spare is driven by the weapon's tag, which is already bound.
    spare.traverse((node) => {
      if (node.name === 'tag_clip') node.name = 'tag_clip_spare';
    });
    // The spare tag is posed by the clip in the weapon's space, so the mount
    // must not re-apply the magwell offset the seated magazine needs.
    spare.position.set(0, 0, 0);
    spare.quaternion.identity();
    spare.visible = false;
    tag.add(spare);
    this.camoRoots.push(spare);
    return spare;
  }

  async load(handsUrl, weaponUrl, magazineUrl, onProgress, {
    magazineOffset = null,
    magazineRotation = null,
  } = {}) {
    // The exported GLBs reference sibling textures as .dds; the web export ships
    // WebP copies instead, so remap the suffix at load time. They were PNG until
    // the nine-rifle roster took this folder to 28 MB on a load that fetches every
    // weapon slot before the player can move; re-encoding cut it to 10 MB with the
    // normal maps kept lossless. See .tools/pack_web_textures.mjs.
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => (url.endsWith('.dds') ? `${url.slice(0, -4)}.webp` : url));
    const loader = new GLTFLoader(manager);
    const textureLoader = new THREE.TextureLoader(manager);
    const load = (url, label) => loader.loadAsync(url, (event) => onProgress?.(label, event));
    const [hands, weapon, magazine, camoTextures] = await Promise.all([
      load(handsUrl, 'hands'),
      load(weaponUrl, 'weapon'),
      magazineUrl
        ? load(magazineUrl, 'magazine').catch((error) => {
          console.warn('Magazine attachment unavailable:', error);
          return null;
        })
        : Promise.resolve(null),
      Promise.all(Object.entries(CUSTOM_CAMOS).map(async ([name, url]) => [
        name,
        await textureLoader.loadAsync(url),
      ])),
    ]);

    this.camoTextures = new Map(camoTextures);
    this.camoRoots = [weapon.scene, ...(magazine ? [magazine.scene] : [])];
    this.setCamo(this.camo);

    this.root.add(hands.scene, weapon.scene);
    // T6 ships the magazine as its own attachment xmodel rather than welding it
    // into the receiver, because the reload xanim animates it out of the well
    // and back in on a `tag_clip` track. Attachment offsets are authored in the
    // weapon model's root space, before its j_gun-to-tag_weapon weld.
    if (magazine) {
      if (Array.isArray(magazineOffset)) magazine.scene.position.fromArray(magazineOffset);
      if (Array.isArray(magazineRotation)) magazine.scene.rotation.set(...magazineRotation);
      weapon.scene.add(magazine.scene);
      this.magazineRoot = magazine.scene;
      this.spareMagazine = this.mountSpareMagazine(weapon.scene, magazine.scene);
    }
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
    this.weaponRoot = weapon.scene;

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

  // ADS: line the eye, the rear sight and the front post up on one axis. The
  // sight picture is a two-point problem — squaring the barrel to the view and
  // centring the front post alone leaves the rear sight wherever it happens to
  // fall. Worse, the eye used to be anchored on tag_sights, which this rig
  // authors on the *front* sight base, putting the camera between the two
  // sights: the rear sight sat about 4 units behind the camera and was never
  // drawn, so only the front post was ever visible down the sight.
  computeAdsAlignment() {
    const jGun = findNode(this.root, 'j_gun');
    const tagSights = findNode(this.root, 'tag_sights')
      ?? findNode(this.root, 'tag_sights_on');
    if (!tagSights || !jGun) return;
    const gunQuat = jGun.getWorldQuaternion(new THREE.Quaternion());
    const gunUp = new THREE.Vector3(0, 0, 1).applyQuaternion(gunQuat).normalize();

    // Each end of the sight line resolves from its override first and from the
    // geometry second, and the two stay independent: hanging the rear on the
    // front discarded a supplied rear anchor whenever findSightTip came up empty
    // — which is every rig the override exists for, since those are the ones
    // with no insert material to key on. The pair then fell through to the
    // single-point fallback, putting the rear sight back behind the camera.
    const front = this.getSightAnchor(jGun, 'front') ?? this.findSightTip(jGun);
    const rear = this.getSightAnchor(jGun, 'rear')
      ?? (front ? this.findRearSight(jGun, front) : null);
    // A rear anchor alone cannot be solved: without a front point there is no
    // line, and on these rigs the geometry cannot supply one either. That is a
    // mis-authored definition rather than a rig the fallback handles, and the
    // fallback's sight picture is the bug this whole solve replaced, so say so.
    if (rear && !front) {
      console.warn('viewmodel: adsSightAnchors.rear needs a matching front anchor on a rig with no sight insert; falling back to tag_sights');
    }

    // With both sights the sight line itself is the aim axis and the rear sight
    // anchors the eye relief. With only one there is no line to solve, so the
    // barrel stands in for it and tag_sights/tag_sights_on anchors the eye, as
    // before.
    const sightLine = Boolean(front && rear);
    const anchor = sightLine ? rear : tagSights.getWorldPosition(new THREE.Vector3());
    const relief = sightLine ? this.adsEyeRelief : this.adsDistance;
    const back = sightLine
      ? rear.clone().sub(front).normalize()
      : new THREE.Vector3(-1, 0, 0).applyQuaternion(gunQuat).normalize();

    // Back/up/right, orthonormalized. makeBasis puts them in the columns, which
    // reads camera coordinates back into the rig; the rig is what has to move,
    // so transpose it into the rig-to-camera direction.
    const zAxis = back;
    const yAxis = gunUp.clone().addScaledVector(zAxis, -gunUp.dot(zAxis)).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    const sightToCamera = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).transpose();

    this.adsMatrix
      .multiplyMatrices(new THREE.Matrix4().makeTranslation(0, 0, -relief), sightToCamera)
      .multiply(new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z));

    // On the fallback path tag_sights is authored on the sight base, about 0.4
    // units below the front post tip the eye actually aligns with, so centring
    // the tag alone floats the sight picture above the ray the shot follows
    // (see WeaponEffects.fire, which casts through the exact screen centre).
    // Slide the rig perpendicular to the view axis until the post tip lands on
    // it; the depth term is left alone so the tag still sets the eye relief.
    // With a rear sight the two-point solve already puts both points on the
    // axis, so there is nothing left to correct.
    if (front && !sightLine) {
      const tip = front.clone().applyMatrix4(this.adsMatrix);
      this.adsMatrix.premultiply(new THREE.Matrix4().makeTranslation(-tip.x, -tip.y, 0));
    }
    this.adsMatrix.decompose(this.adsPos, this.adsQuat, this.adsScale);
  }

  // The top of the rear sight in world space. Precision matters here: the solve
  // above runs its axis through whatever point this returns, so an error of e
  // leaves the rear sight sitting e/adsEyeRelief off the front post on screen —
  // a hundredth of a unit is worth a couple of pixels.
  findRearSight(jGun, frontTip) {
    const toGun = new THREE.Matrix4().copy(jGun.matrixWorld).invert();
    const front = frontTip.clone().applyMatrix4(toGun);
    const vertex = new THREE.Vector3();
    let best = null;

    // Only the weapon: the hands wrap the grip and handguard and could stray
    // into the search band, and there is no material to tell them apart here.
    (this.weaponRoot ?? this.root).traverse((object) => {
      if (!object.isMesh) return;
      const toGunLocal = new THREE.Matrix4().multiplyMatrices(toGun, object.matrixWorld);
      const position = object.geometry.getAttribute('position');
      const index = object.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i += 1) {
        const vertexIndex = index ? index.getX(i) : i;
        vertex.fromBufferAttribute(position, vertexIndex);
        if (object.isSkinnedMesh) object.applyBoneTransform(vertexIndex, vertex);
        vertex.applyMatrix4(toGunLocal);
        // j_gun holds the engine's joint axes: X down the barrel, Y left, Z up.
        if (vertex.x > front.x - REAR_SIGHT_MIN_RADIUS) continue;
        if (Math.abs(vertex.y - front.y) > REAR_SIGHT_HALF_WIDTH) continue;
        if (Math.abs(vertex.z - front.z) > REAR_SIGHT_PLANE_BAND) continue;
        if (!best || vertex.z > best.z) best = vertex.clone();
      }
    });
    if (!best) return null;
    // The winning vertex is one of the two shoulders, so its own lateral offset
    // is meaningless — the sight is symmetric about the weapon's centreline and
    // that is where the eye looks. Keeping the shoulder's 0.2 offset would swing
    // the sight picture sideways by 0.2/adsEyeRelief, most of a degree.
    best.y = front.y;
    return jGun.localToWorld(best);
  }

  // Top-centre of the front post's tritium insert in world space, read off the
  // posed geometry — the far half of the sight picture, and the point the shot
  // ray is made to pass through. It is authored level with the floor of the rear
  // notch, which is why the notch floor is the one point that must *not* be used
  // to aim: see findRearSight. Rigs that ship no such element fall back to
  // tag_sights/tag_sights_on alone.
  findSightTip(jGun) {
    const box = new THREE.Box3();
    const vertex = new THREE.Vector3();
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.some((material) => SIGHT_INSERT_PATTERN.test(material?.name ?? ''))) return;
      // Every surface of the exported weapon shares one position buffer and is
      // cut out of it by index, so walk the indices, not the whole attribute.
      const position = object.geometry.getAttribute('position');
      const index = object.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i += 1) {
        const vertexIndex = index ? index.getX(i) : i;
        vertex.fromBufferAttribute(position, vertexIndex);
        if (object.isSkinnedMesh) object.applyBoneTransform(vertexIndex, vertex);
        object.localToWorld(vertex);
        box.expandByPoint(jGun.worldToLocal(vertex));
      }
    });
    if (box.isEmpty()) return null;

    // j_gun holds the engine's joint axes: X down the barrel, Y left, Z up.
    const tip = box.getCenter(new THREE.Vector3());
    tip.z = box.max.z;
    return jGun.localToWorld(tip);
  }

  getSightAnchor(jGun, key) {
    const point = this.adsSightAnchors?.[key];
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
      return null;
    }
    return jGun.localToWorld(new THREE.Vector3().fromArray(point));
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
          // tag_clip's rotation is authored relative to the animation's first
          // pose, while the converted attachment binds at -90 degrees about X.
          // Apply the authored delta before that bind transform. Multiplying it
          // after the bind rotates around the converted axes and turns the
          // magazine upside-down as it leaves the well.
          if (bone.name === 'tag_clip') {
            const sourceBindInverse = new THREE.Quaternion(
              values[0], values[1], values[2], values[3],
            ).invert();
            const targetBind = node.quaternion.clone();
            const key = new THREE.Quaternion();
            for (let i = 0; i < values.length; i += 4) {
              key.set(values[i], values[i + 1], values[i + 2], values[i + 3])
                .multiply(sourceBindInverse)
                .multiply(targetBind);
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
          // Magazine channels are authored as displacements, so each one has to
          // be anchored on the pose it is a displacement *from*. The two halves
          // of a mag change anchor on opposite ends. The magazine in the weapon
          // starts seated, so tag_clip anchors its first key on the attachment's
          // bind in the magwell. The fresh magazine instead *finishes* seated,
          // arriving from wherever the hand carried it, so a spare tag anchors
          // its last key on the seated magazine. Anchoring a spare on its first
          // key assumes it starts in the well, which is only ever true when its
          // track happens to open on the origin — it does on the sa58 and not on
          // the an94 or sig556, so that rule fixed one rig and displaced two.
          if (MAGAZINE_TAGS.has(bone.name)) {
            const seats = SPARE_MAGAZINE_TAGS.includes(bone.name);
            const target = seats
              ? this.seatedMagazineIn(node.parent)
              : node.position;
            const from = seats ? values.length - 3 : 0;
            const offset = [
              target.x - values[from],
              target.y - values[from + 1],
              target.z - values[from + 2],
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
    if (this.clips.has('introFire') && this.idleAction) {
      this.introFireAction = this.mixer.clipAction(this.clips.get('introFire'));
      this.introFireAction.setLoop(THREE.LoopOnce, 1);
    }
    if (this.clips.has('introAdsFire') && this.idleAction) {
      this.introAdsFireAction = this.mixer.clipAction(this.clips.get('introAdsFire'));
      this.introAdsFireAction.setLoop(THREE.LoopOnce, 1);
    }
  }

  onClipFinished(event) {
    if (event.action === this.reloadAction || event.action === this.reloadEmptyAction) {
      this.reloading = false;
      this.showSpareMagazine(false);
      this.stopNotetracks();
      this.idleAction.reset().fadeIn(0.12).play();
      event.action.fadeOut(0.12);
      return;
    }
    if ([this.fireAction, this.adsFireAction, this.introFireAction, this.introAdsFireAction]
      .includes(event.action)) {
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
    this.introFireAction?.stop();
    this.introAdsFireAction?.stop();
    action.reset().fadeIn(0.12).play();
    this.idleAction.fadeOut(0.12);
    // The empty magazine still holds the well; the fresh one waits for mag_out.
    this.showSpareMagazine(false);
    this.startNotetracks(empty && this.reloadEmptyAction ? 'reloadEmpty' : 'reload', action);
    return true;
  }

  // Where the seated magazine rests, expressed in `space`'s local frame. This is
  // the pose the fresh magazine has to arrive at, and the two live under
  // different parents, so it goes through world space rather than assuming any
  // particular hierarchy.
  seatedMagazineIn(space) {
    const seated = new THREE.Vector3();
    if (!this.magazineRoot || !space) return seated;
    this.root.updateMatrixWorld(true);
    this.magazineRoot.getWorldPosition(seated);
    return space.worldToLocal(seated);
  }

  // Exactly one magazine is ever on the gun. The empty one holds the well until
  // the clip releases it, the fresh one owns the rest of the reload, and the
  // swap happens on the mag_out cue, which is authored at the moment of release.
  //
  // Showing the fresh one for the whole reload instead put two magazines on the
  // gun: the tracks park it wherever the hand is about to pick it up, and on the
  // sig556 that is the magwell itself for the first 1.6s of a 2.5s clip. Timing
  // the swap off the cue keeps it correct without per-rig tuning, since the cue
  // is authored against the same motion on every rig.
  handOverMagazine() {
    if (!this.spareMagazine) return false;
    this.spareMagazine.visible = true;
    if (this.magazineRoot) this.magazineRoot.visible = false;
    return true;
  }

  // Back to the resting state: the empty magazine's track has run itself out to
  // wherever it was thrown, but the action stops with it and the node returns to
  // its bind in the well, so the seated magazine is the right one to show again.
  showSpareMagazine(visible) {
    if (!this.spareMagazine) return false;
    this.spareMagazine.visible = Boolean(visible);
    if (this.magazineRoot) this.magazineRoot.visible = !visible;
    return true;
  }

  cancelReload() {
    if (!this.reloading) return false;
    this.reloadAction?.stop();
    this.reloadEmptyAction?.stop();
    this.stopNotetracks();
    this.reloading = false;
    this.showSpareMagazine(false);
    this.idleAction?.reset().fadeIn(0.08).play();
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

  fire({ intro = false } = {}) {
    if (!this.ready || this.reloading) return false;
    const aiming = this.aimBlend > 0.5;
    const action = intro
      ? (aiming && this.introAdsFireAction ? this.introAdsFireAction : this.introFireAction)
      : (aiming && this.adsFireAction ? this.adsFireAction : this.fireAction);
    if (action) {
      for (const other of [
        this.fireAction,
        this.adsFireAction,
        this.introFireAction,
        this.introAdsFireAction,
      ]) {
        if (other !== action) other?.stop();
      }
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
        if (MAGAZINE_HANDOVER_CUE.test(cue.name)) this.handOverMagazine();
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
