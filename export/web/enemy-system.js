import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
const MODEL_FORWARD_OFFSET = Math.PI / 2;
const _direction = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _velocity = new THREE.Vector3();
const _point = new THREE.Vector3();
const _sphere = new THREE.Sphere();

function findNode(root, name) {
  return root.getObjectByName(name) ?? null;
}

function planarDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function dampAngle(current, target, lambda, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * dt));
}

function animationClip(key, data, root) {
  const tracks = [];
  for (const bone of data.bones ?? []) {
    const target = findNode(root, bone.name);
    if (!target) continue;
    if (bone.rot?.values?.length) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        bone.rot.frames.map((frame) => frame / data.fps),
        bone.rot.values,
      ));
    }
    if (bone.pos?.values?.length) {
      const values = bone.pos.values.slice();
      // Body xanims carry an authored placement for j_mainroot that belongs to
      // the source animation scene. Rebase that track to this model's bind
      // root so every clip remains in-place with its feet on the crowd point.
      if (bone.name === 'j_mainroot') {
        const offset = [
          target.position.x - values[0],
          target.position.y - values[1],
          target.position.z - values[2],
        ];
        for (let i = 0; i < values.length; i += 3) {
          values[i] += offset[0];
          values[i + 1] += offset[1];
          values[i + 2] += offset[2];
        }
      }
      tracks.push(new THREE.VectorKeyframeTrack(
        `${bone.name}.position`,
        bone.pos.frames.map((frame) => frame / data.fps),
        values,
      ));
    }
  }
  return new THREE.AnimationClip(key, data.duration, tracks);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`enemy animation HTTP ${response.status}: ${url}`);
  return response.json();
}

function optimizeEnemyMaterials(root) {
  const converted = new Map();
  const convert = (source) => {
    if (!source) return source;
    if (converted.has(source)) return converted.get(source);
    const material = new THREE.MeshLambertMaterial({
      name: `${source.name || 'enemy'}_fast`,
      color: source.color?.clone() ?? new THREE.Color(0xffffff),
      map: source.map ?? null,
      alphaMap: source.alphaMap ?? null,
      alphaTest: source.alphaTest ?? 0,
      transparent: source.transparent ?? false,
      opacity: source.opacity ?? 1,
      side: source.side ?? THREE.FrontSide,
      depthWrite: source.depthWrite ?? true,
    });
    converted.set(source, material);
    return material;
  };
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(convert)
      : convert(object.material);
  });
}

function createBodyAtlas(root) {
  const maps = [];
  const mapIndices = new Map();
  const register = (map) => {
    const key = map ?? null;
    if (mapIndices.has(key)) return;
    mapIndices.set(key, maps.length);
    maps.push(key);
  };
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => register(material?.map ?? null));
  });

  const columns = Math.ceil(Math.sqrt(maps.length));
  const rows = Math.ceil(maps.length / columns);
  const cellSize = 256;
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellSize;
  canvas.height = rows * cellSize;
  const context = canvas.getContext('2d', { alpha: true });
  context.imageSmoothingEnabled = true;
  maps.forEach((map, index) => {
    const x = (index % columns) * cellSize;
    const y = Math.floor(index / columns) * cellSize;
    context.fillStyle = '#ffffff';
    context.fillRect(x, y, cellSize, cellSize);
    if (map?.image) context.drawImage(map.image, x, y, cellSize, cellSize);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'enemy_body_atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.MeshLambertMaterial({
    name: 'enemy_body_atlas_fast',
    map: texture,
    alphaTest: 0.05,
  });
  return { columns, rows, mapIndices, material };
}

function collapseBakedBody(root, atlas) {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const sources = [];
  let vertexCount = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    const count = object.geometry.index?.count ?? object.geometry.attributes.position.count;
    sources.push({ object, material, count });
    vertexCount += count;
  });

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const uv = new THREE.Vector2();
  let cursor = 0;

  for (const { object, material, count } of sources) {
    const geometry = object.geometry;
    const positionAttribute = geometry.attributes.position;
    const normalAttribute = geometry.attributes.normal;
    const uvAttribute = geometry.attributes.uv;
    const indexAttribute = geometry.index;
    const meshToRoot = rootInverse.clone().multiply(object.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshToRoot);
    const atlasIndex = atlas.mapIndices.get(material?.map ?? null) ?? 0;
    const column = atlasIndex % atlas.columns;
    const row = Math.floor(atlasIndex / atlas.columns);
    for (let i = 0; i < count; i += 1) {
      const sourceIndex = indexAttribute ? indexAttribute.getX(i) : i;
      vertex.fromBufferAttribute(positionAttribute, sourceIndex).applyMatrix4(meshToRoot);
      vertex.toArray(positions, cursor * 3);
      if (normalAttribute) normal.fromBufferAttribute(normalAttribute, sourceIndex).applyNormalMatrix(normalMatrix);
      else normal.set(0, 1, 0);
      normal.toArray(normals, cursor * 3);
      if (uvAttribute) uv.fromBufferAttribute(uvAttribute, sourceIndex);
      else uv.set(0.5, 0.5);
      // A small inset prevents mip filtering from bleeding adjacent atlas cells.
      uvs[cursor * 2] = (column + 0.01 + uv.x * 0.98) / atlas.columns;
      uvs[cursor * 2 + 1] = (row + 0.01 + uv.y * 0.98) / atlas.rows;
      cursor += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const combined = new THREE.Mesh(geometry, atlas.material);
  combined.name = 'enemy_body_combined';
  combined.frustumCulled = true;
  combined.castShadow = false;
  combined.receiveShadow = true;
  for (const { object } of sources) object.parent?.remove(object);
  root.add(combined);
}

function bakeSkinnedMeshes(root) {
  const replacements = [];
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isSkinnedMesh) return;
    object.skeleton.update();
    const geometry = object.geometry.clone();
    const sourcePosition = object.geometry.attributes.position;
    const positions = new Float32Array(sourcePosition.count * 3);
    const vertex = new THREE.Vector3();
    for (let i = 0; i < sourcePosition.count; i += 1) {
      object.getVertexPosition(i, vertex);
      vertex.toArray(positions, i * 3);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.deleteAttribute('skinIndex');
    geometry.deleteAttribute('skinWeight');
    geometry.morphAttributes = {};
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, object.material);
    mesh.name = object.name;
    mesh.position.copy(object.position);
    mesh.quaternion.copy(object.quaternion);
    mesh.scale.copy(object.scale);
    mesh.matrixAutoUpdate = object.matrixAutoUpdate;
    if (!object.matrixAutoUpdate) mesh.matrix.copy(object.matrix);
    mesh.renderOrder = object.renderOrder;
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData = { ...object.userData };
    replacements.push({ object, mesh });
  });
  for (const { object, mesh } of replacements) {
    const parent = object.parent;
    if (!parent) continue;
    parent.add(mesh);
    parent.remove(object);
  }
  return replacements.length;
}

function bakePoseFrame(bodyTemplate, clip, time, atlas) {
  const body = SkeletonUtils.clone(bodyTemplate);
  const mixer = new THREE.AnimationMixer(body);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
  action.play();
  mixer.setTime(Math.max(0, Math.min(time, clip.duration * 0.9999)));
  body.updateMatrixWorld(true);
  bakeSkinnedMeshes(body);
  collapseBakedBody(body, atlas);
  // Do not stop/uncache this temporary mixer: Three.js restores bound bones
  // when an action is uncached. The mixer becomes unreachable after this
  // function, while the sampled wrist transform remains available for the
  // weapon mounted to this otherwise-static pose.
  return body;
}

function bakePoseSequence(bodyTemplate, clip, frameCount, atlas, includeEnd = false) {
  const count = Math.max(1, frameCount);
  return Array.from({ length: count }, (_, index) => {
    const divisor = includeEnd ? Math.max(1, count - 1) : count;
    return bakePoseFrame(bodyTemplate, clip, clip.duration * index / divisor, atlas);
  });
}

function attachWeapon(body, weapon, actorRoot) {
  // In this PLA export tag_inhand sits high on the back and
  // tag_weapon_right is offset toward the chest. The wrist bone is the
  // reliable palm anchor for the rigid world weapon.
  const hand = findNode(body, 'j_wrist_ri')
    ?? findNode(body, 'tag_weapon_right')
    ?? findNode(body, 'tag_inhand');
  const mount = findNode(weapon, 'tag_weapon');
  if (!hand || !mount) return null;
  weapon.updateMatrixWorld(true);
  weapon.matrixAutoUpdate = false;
  weapon.matrix.copy(mount.matrixWorld).invert();
  hand.add(weapon);
  actorRoot?.updateMatrixWorld(true);

  const muzzle = findNode(weapon, 'tag_flash');
  if (muzzle && actorRoot) {
    // The exported world weapon uses a different forward axis than the body
    // hand tag. Keep tag_weapon pinned to the hand, but rotate the weapon
    // around that socket so its barrel follows the actor's gameplay forward.
    const handPosition = hand.getWorldPosition(new THREE.Vector3());
    const muzzlePosition = muzzle.getWorldPosition(new THREE.Vector3());
    const currentDirection = muzzlePosition.sub(handPosition).normalize();
    const desiredDirection = new THREE.Vector3(0, -0.06, -1).normalize();
    desiredDirection.applyQuaternion(actorRoot.getWorldQuaternion(new THREE.Quaternion()));

    const inverseHandRotation = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    currentDirection.applyQuaternion(inverseHandRotation).normalize();
    desiredDirection.applyQuaternion(inverseHandRotation).normalize();
    const correction = new THREE.Quaternion().setFromUnitVectors(currentDirection, desiredDirection);
    weapon.matrix.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(correction));
    actorRoot.updateMatrixWorld(true);
  }
  return { hand, mount, muzzle };
}

function makeHitbox(geometry, position, enemy, multiplier, region) {
  const material = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.userData.enemyHit = { enemy, multiplier, region };
  mesh.name = `enemy_hit_${region}`;
  return mesh;
}

class Enemy {
  constructor(manager, spawn, index) {
    this.manager = manager;
    this.index = index;
    this.maxHealth = manager.enemyHealth;
    this.health = this.maxHealth;
    this.dead = false;
    this.state = 'patrol';
    this.lastSeen = new THREE.Vector3();
    this.lastSeenTimer = 0;
    this.decisionTimer = Math.random() * 0.2;
    this.fireTimer = 0.4 + Math.random() * 0.7;
    this.respawnTimer = 0;
    this.patrolTarget = null;
    this.walkTime = Math.random() * Math.PI * 2;
    this.deathBlend = 0;
    this.playerVisible = false;
    this.spawnPoint = {
      position: spawn.position.clone(),
      authoredPosition: spawn.authoredPosition?.clone() ?? spawn.position.clone(),
      yaw: Number(spawn.yaw) || 0,
      classname: spawn.classname ?? 'unknown',
      markerIndex: spawn.markerIndex ?? index,
    };

    this.root = new THREE.Group();
    this.root.name = `enemy_${index}`;
    this.root.rotation.y = Number(spawn.yaw) || 0;
    this.modelRoot = new THREE.Group();
    this.modelRoot.rotation.y = MODEL_FORWARD_OFFSET;
    this.root.add(this.modelRoot);

    // Every enemy reuses the same baked geometry buffers. Only one pose root
    // is visible at a time, so walking costs ordinary static-mesh rendering
    // instead of six independently skinned characters on every frame.
    this.visualFrames = Object.fromEntries(Object.entries(manager.poseTemplates).map(([state, templates]) => [
      state,
      templates.map((template) => {
        const body = template.clone(true);
        const weapon = manager.weaponTemplate.clone(true);
        this.modelRoot.add(body);
        const mounts = attachWeapon(body, weapon, this.root);
        this.modelRoot.remove(body);
        return { body, weapon, ...mounts };
      }),
    ]));
    this.visualState = null;
    this.visualFrameIndex = -1;
    this.visualTime = 0;
    this.visualTimeScale = 1;
    this.body = null;
    this.weapon = null;
    this.handMount = null;
    this.weaponMount = null;
    this.muzzle = null;
    this.currentAction = null;
    this.staticVisual = true;
    this.bakedMeshCount = manager.bakedWeaponMeshCount;
    this.showVisualFrame('idle', 0);

    this.hitboxes = [
      makeHitbox(new THREE.BoxGeometry(18, 34, 15), new THREE.Vector3(0, 43, 0), this, 1, 'torso'),
      makeHitbox(new THREE.SphereGeometry(7, 8, 6), new THREE.Vector3(0, 65, 0), this, 2, 'head'),
      makeHitbox(new THREE.BoxGeometry(17, 29, 13), new THREE.Vector3(0, 16, 0), this, 0.75, 'legs'),
    ];
    this.root.add(...this.hitboxes);
    manager.scene.add(this.root);
    this.spawnAt(spawn);
  }

  showVisualFrame(state, index) {
    const frames = this.visualFrames[state] ?? this.visualFrames.idle;
    const nextIndex = THREE.MathUtils.clamp(index, 0, frames.length - 1);
    if (this.visualState === state && this.visualFrameIndex === nextIndex) return;
    if (this.visualState) {
      this.modelRoot.remove(this.visualFrames[this.visualState][this.visualFrameIndex].body);
    }
    const frame = frames[nextIndex];
    this.modelRoot.add(frame.body);
    this.visualState = state;
    this.visualFrameIndex = nextIndex;
    this.body = frame.body;
    this.weapon = frame.weapon;
    this.handMount = frame.hand ?? null;
    this.weaponMount = frame.mount ?? null;
    this.muzzle = frame.muzzle ?? null;
  }

  advanceVisual(deltaSeconds) {
    const frames = this.visualFrames[this.visualState] ?? this.visualFrames.idle;
    if (frames.length <= 1) return;
    this.visualTime += deltaSeconds * this.visualTimeScale;
    const frameRate = this.manager.poseFrameRates[this.visualState] ?? 1;
    const rawIndex = Math.floor(this.visualTime * frameRate);
    const index = this.visualState === 'death'
      ? Math.min(frames.length - 1, rawIndex)
      : rawIndex % frames.length;
    this.showVisualFrame(this.visualState, index);
  }

  spawnAt(spawn) {
    const projected = this.manager.navigation.projectPoint(spawn.position);
    if (!projected.success || !projected.point) throw new Error('enemy spawn is outside the navmesh');
    if (this.agent) this.manager.navigation.crowd.removeAgent(this.agent);
    this.agent = this.manager.navigation.addAgent(projected.point, {
      radius: 16,
      height: 72,
      maxAcceleration: 520,
      maxSpeed: this.manager.moveSpeed,
      collisionQueryRange: 96,
      pathOptimizationRange: 240,
      separationWeight: 3,
      userData: this.index,
    });
    this.root.position.copy(projected.point);
    this.root.rotation.y = Number(spawn.yaw) || 0;
    this.health = this.maxHealth;
    this.dead = false;
    this.state = 'patrol';
    this.respawnTimer = 0;
    this.lastSeenTimer = 0;
    this.patrolTarget = null;
    this.decisionTimer = Math.random() * 0.25;
    this.fireTimer = 0.4 + Math.random() * 0.6;
    this.deathBlend = 0;
    this.playerVisible = false;
    this.modelRoot.position.y = 0;
    this.modelRoot.rotation.z = 0;
    this.playAction('idle', 0);
    this.root.visible = true;
    this.root.updateMatrixWorld(true);
  }

  teleport(position) {
    const projected = this.manager.navigation.projectPoint(position);
    if (!projected.success || !projected.point) return false;
    this.agent?.teleport(projected.point);
    this.root.position.copy(projected.point);
    this.root.updateMatrixWorld(true);
    return true;
  }

  playAction(name) {
    const state = this.visualFrames[name] ? name : 'idle';
    if (state === this.visualState) return;
    this.visualTime = state === 'run'
      ? this.walkTime % this.manager.clips.run.duration
      : 0;
    this.visualTimeScale = 1;
    this.showVisualFrame(state, 0);
    this.currentAction = { _clip: { name: state } };
  }

  takeDamage(amount, hit = null) {
    if (this.dead) return 0;
    const damage = Math.max(0, Number(amount) || 0);
    const applied = Math.min(this.health, damage);
    this.health -= applied;
    this.lastSeen.copy(this.manager.player.position);
    this.lastSeenTimer = 6;
    if (this.health <= 0) this.die();
    else {
      this.state = 'chase';
      this.manager.alert(this.root.position, 800, this.manager.player.position);
    }
    return applied;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    this.respawnTimer = this.manager.respawnDelay;
    if (this.agent) {
      this.agent.resetMoveTarget();
      this.manager.navigation.crowd.removeAgent(this.agent);
      this.agent = null;
    }
    this.playAction('death', 0.08);
  }

  eyePosition(target = new THREE.Vector3()) {
    return target.copy(this.root.position).addScaledVector(UP, 61);
  }

  muzzlePosition(target = new THREE.Vector3()) {
    if (this.muzzle) return this.muzzle.getWorldPosition(target);
    return this.eyePosition(target);
  }

  choosePatrolTarget() {
    this.patrolTarget = this.manager.findPatrolPoint(this.root.position);
    if (this.patrolTarget) this.agent?.requestMoveTarget(this.patrolTarget);
  }

  decide() {
    const playerHealth = this.manager.playerHealth;
    if (playerHealth?.dead) {
      this.playerVisible = false;
      this.state = 'patrol';
      if (!this.patrolTarget) this.choosePatrolTarget();
      return;
    }

    const playerPosition = this.manager.player.position;
    const distance = this.root.position.distanceTo(playerPosition);
    const alreadyAlerted = this.lastSeenTimer > 0 || this.state === 'chase' || this.state === 'attack';
    const visible = distance <= this.manager.visionRange &&
      this.manager.canSeePlayer(this, alreadyAlerted ? -0.2 : this.manager.visionCosine);
    this.playerVisible = visible;

    if (visible) {
      this.lastSeen.copy(playerPosition);
      this.lastSeenTimer = this.manager.memoryTime;
      if (distance <= this.manager.attackRange) {
        this.state = 'attack';
        this.agent?.resetMoveTarget();
      } else {
        this.state = 'chase';
        const projected = this.manager.navigation.projectPoint(this.manager.player.feetPosition);
        if (projected.success && projected.point) this.agent?.requestMoveTarget(projected.point);
      }
      return;
    }

    if (this.lastSeenTimer > 0) {
      this.state = 'chase';
      const projected = this.manager.navigation.projectPoint(this.lastSeen);
      if (projected.success && projected.point) this.agent?.requestMoveTarget(projected.point);
      return;
    }

    this.state = 'patrol';
    if (!this.patrolTarget || planarDistance(this.root.position, this.patrolTarget) < 50) {
      this.choosePatrolTarget();
    }
  }

  update(deltaSeconds, active) {
    const dt = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.1));

    if (this.dead) {
      if (!active) return;
      this.advanceVisual(dt);
      this.deathBlend = Math.min(1, this.deathBlend + dt * 2.8);
      this.modelRoot.rotation.z = -this.deathBlend * 1.35;
      this.modelRoot.position.y = -this.deathBlend * 10;
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.spawnAt(this.manager.respawnFor(this));
      return;
    }

    if (this.agent) {
      const p = this.agent.interpolatedPosition;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
        this.root.position.set(p.x, p.y, p.z);
      } else {
        const fixed = this.agent.position();
        this.root.position.set(fixed.x, fixed.y, fixed.z);
      }
      const velocity = this.agent.velocity();
      _velocity.set(velocity.x, velocity.y, velocity.z);
    } else {
      _velocity.set(0, 0, 0);
    }

    if (!active) return;
    this.lastSeenTimer = Math.max(0, this.lastSeenTimer - dt);
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) {
      // Full-map collision raycasts are deliberately staggered and cached.
      // Rechecking six actors several times per frame causes input-blocking
      // spikes when enemies gather around walls or doorways.
      this.decisionTimer += 0.36 + Math.random() * 0.1;
      this.decide();
    }

    const horizontalSpeed = Math.hypot(_velocity.x, _velocity.z);
    if (this.state === 'attack') {
      _direction.subVectors(this.manager.player.position, this.root.position).setY(0);
      if (_direction.lengthSq() > 1) {
        const targetYaw = Math.atan2(-_direction.x, -_direction.z);
        this.root.rotation.y = dampAngle(this.root.rotation.y, targetYaw, 10, dt);
      }
      this.playAction('idle');
      if (this.fireTimer <= 0) {
        this.fireTimer = this.manager.fireInterval * (0.85 + Math.random() * 0.35);
        if (this.playerVisible && this.manager.canEnemyFire(this)) this.manager.enemyFire(this);
      }
    } else if (horizontalSpeed > 10) {
      const targetYaw = Math.atan2(-_velocity.x, -_velocity.z);
      this.root.rotation.y = dampAngle(this.root.rotation.y, targetYaw, 9, dt);
      this.playAction('run');
      this.visualTimeScale = THREE.MathUtils.clamp(horizontalSpeed / 210, 0.65, 1.35);
      this.walkTime += dt * THREE.MathUtils.clamp(horizontalSpeed / 28, 5, 10);
      this.modelRoot.position.y = Math.sin(this.walkTime) * 0.8;
    } else {
      this.playAction('idle');
      this.modelRoot.position.y = THREE.MathUtils.damp(this.modelRoot.position.y, 0, 12, dt);
    }
    this.advanceVisual(dt);
    this.root.updateMatrixWorld(true);
  }
}

export class EnemyManager {
  constructor({
    scene,
    navigation,
    collisionRoot,
    player,
    playerHealth,
    weaponEffects,
    hints,
    count = 6,
    enemyHealth = 100,
    moveSpeed = 230,
    visionRange = 1700,
    attackRange = 850,
    fieldOfView = 125,
    memoryTime = 5,
    fireInterval = 0.65,
    enemyDamage = 3,
    maxAttackers = 2,
    respawnDelay = 6,
  }) {
    if (!scene || !navigation?.crowd || !collisionRoot || !player) {
      throw new Error('EnemyManager requires scene, crowd navigation, collision, and player');
    }
    Object.assign(this, {
      scene, navigation, collisionRoot, player, playerHealth, weaponEffects, hints,
      count, enemyHealth, moveSpeed, visionRange, attackRange, memoryTime,
      fireInterval, enemyDamage, maxAttackers, respawnDelay,
    });
    this.visionCosine = Math.cos(THREE.MathUtils.degToRad(fieldOfView / 2));
    this.enemies = [];
    this.clips = Object.create(null);
    this.raycaster = new THREE.Raycaster();
    this.spawnCursor = 0;
    this.bodyTemplate = null;
    this.weaponTemplate = null;
    this.poseTemplates = null;
    this.poseFrameRates = null;
    this.bodyAtlas = null;
    this.weaponAtlas = null;
    this.bakedWeaponMeshCount = 0;
    this.spawnCandidates = [];
    this.patrolPoints = [];
  }

  async load({
    // LOD2 retains the complete animated rig at about one eighth of LOD0's
    // skinned vertices. The world-weapon LOD1 likewise keeps all mount tags.
    bodyUrl = 'enemies/c_chn_mp_pla_assault_fb_lod2.glb',
    weaponUrl = 'enemies/t6_wpn_ar_hk416_world_lod1.glb',
    animations = {
      idle: 'enemies/anims/pb_hold_idle.json',
      run: 'enemies/anims/pb_hold_run.json',
      death: 'enemies/anims/pb_death_faceplant.json',
    },
    onProgress = null,
  } = {}) {
    const loadingManager = new THREE.LoadingManager();
    loadingManager.setURLModifier((url) => {
      if (!url.toLowerCase().endsWith('.dds')) return url;
      const normalized = url.replaceAll('\\', '/');
      const filename = normalized.slice(normalized.lastIndexOf('/') + 1, -4);
      return `enemies/textures/${filename}.png`;
    });
    const loader = new GLTFLoader(loadingManager);
    const loadModel = (url, label) => loader.loadAsync(url, (event) => onProgress?.(label, event));
    const [body, weapon, clipData] = await Promise.all([
      loadModel(bodyUrl, 'enemy'),
      loadModel(weaponUrl, 'enemy weapon'),
      Promise.all(Object.entries(animations).map(async ([key, url]) => [key, await fetchJson(url)])),
    ]);
    optimizeEnemyMaterials(body.scene);
    optimizeEnemyMaterials(weapon.scene);
    this.bodyTemplate = body.scene;
    this.weaponTemplate = weapon.scene;
    this.clips = Object.fromEntries(clipData.map(([key, data]) => [
      key,
      animationClip(key, data, this.bodyTemplate),
    ]));
    this.bodyAtlas = createBodyAtlas(this.bodyTemplate);
    this.weaponAtlas = createBodyAtlas(this.weaponTemplate);
    this.poseTemplates = {
      idle: bakePoseSequence(this.bodyTemplate, this.clips.idle, 1, this.bodyAtlas),
      run: bakePoseSequence(this.bodyTemplate, this.clips.run, 20, this.bodyAtlas),
      death: bakePoseSequence(this.bodyTemplate, this.clips.death, 6, this.bodyAtlas, true),
    };
    this.poseFrameRates = {
      idle: 1,
      run: this.poseTemplates.run.length / this.clips.run.duration,
      death: (this.poseTemplates.death.length - 1) / this.clips.death.duration,
    };
    this.bakedWeaponMeshCount = bakeSkinnedMeshes(this.weaponTemplate);
    collapseBakedBody(this.weaponTemplate, this.weaponAtlas);
    this.prepareNavigationPoints();
    const spawns = this.spawnCandidates.slice(0, Math.min(this.count, this.spawnCandidates.length));
    for (let i = 0; i < spawns.length; i += 1) this.enemies.push(new Enemy(this, spawns[i], i));
    return this;
  }

  prepareNavigationPoints() {
    const playerFeet = this.player.feetPosition;
    const authoredSpawns = this.hints?.spawns ?? [];
    const spawnClassPriority = [
      // The player starts at the team-one/bow end of Hijacked. These are the
      // six original opposing-team locations at the stern end of the map.
      'mp_tdm_spawn_team2_start',
      'mp_tdm_spawn_allies_start',
      'mp_tdm_spawn',
      'mp_dm_spawn',
    ];
    this.spawnCandidates = [];
    for (const classname of spawnClassPriority) {
      const projected = authoredSpawns
        .map((marker, markerIndex) => ({ marker, markerIndex }))
        .filter(({ marker }) => marker.classname === classname)
        .map(({ marker, markerIndex }) => {
          const authoredPosition = new THREE.Vector3(...marker.position);
          const result = this.navigation.projectPoint(authoredPosition);
          if (!result.success || !result.point) return null;
          return {
            position: result.point,
            authoredPosition,
            yaw: Number(marker.yaw) || 0,
            classname,
            markerIndex,
            distance: planarDistance(authoredPosition, playerFeet),
          };
        })
        .filter(Boolean);
      if (projected.length < this.count) continue;
      // Team-specific starts retain their authored slot order. Generic
      // fallback spawns choose the farthest markers, never the closest ones.
      if (classname === 'mp_tdm_spawn' || classname === 'mp_dm_spawn') {
        projected.sort((a, b) => b.distance - a.distance);
      }
      this.spawnCandidates = projected;
      break;
    }

    for (const node of this.hints?.pathnodes ?? []) {
      const result = this.navigation.projectPoint(new THREE.Vector3(...node.position));
      if (result.success && result.point &&
          !this.patrolPoints.some((point) => planarDistance(point, result.point) < 80)) {
        this.patrolPoints.push(result.point);
      }
    }
  }

  get aliveCount() {
    return this.enemies.reduce((count, enemy) => count + Number(!enemy.dead), 0);
  }

  get hitTargets() {
    return this.enemies.flatMap((enemy) => enemy.dead ? [] : enemy.hitboxes);
  }

  // Returns what the shot actually did so the HUD can confirm it. A miss and a
  // hit on an already-dead body both report null.
  handlePlayerHit(hit, baseDamage = 34) {
    const data = hit?.object?.userData?.enemyHit;
    if (!data?.enemy || data.enemy.dead) return null;
    const multiplier = data.multiplier ?? 1;
    const damage = data.enemy.takeDamage(baseDamage * multiplier, hit);
    return {
      enemy: data.enemy,
      region: data.region ?? 'torso',
      multiplier,
      damage,
      killed: data.enemy.dead,
    };
  }

  canSeePlayer(enemy, minimumDot = this.visionCosine) {
    enemy.eyePosition(_origin);
    _target.copy(this.player.position);
    _direction.subVectors(_target, _origin);
    const distance = _direction.length();
    if (distance <= 0.001) return true;
    _direction.multiplyScalar(1 / distance);
    _forward.set(0, 0, -1).applyQuaternion(enemy.root.quaternion);
    if (_forward.dot(_direction) < minimumDot) return false;
    this.raycaster.set(_origin, _direction);
    this.raycaster.near = 2;
    this.raycaster.far = distance;
    const wall = this.raycaster.intersectObject(this.collisionRoot, true)[0];
    return !wall || wall.distance >= distance - 4;
  }

  enemyFire(enemy) {
    enemy.muzzlePosition(_origin);
    const feet = this.player.feetPosition;
    _target.set(feet.x, feet.y + 42, feet.z);
    const distance = _origin.distanceTo(_target);
    const spread = 5 + distance * 0.018;
    _target.x += (Math.random() - 0.5) * spread;
    _target.y += (Math.random() - 0.5) * spread;
    _target.z += (Math.random() - 0.5) * spread;
    _direction.subVectors(_target, _origin).normalize();

    this.raycaster.set(_origin, _direction);
    this.raycaster.near = 1;
    this.raycaster.far = this.attackRange + 200;
    _sphere.center.set(feet.x, feet.y + 39, feet.z);
    _sphere.radius = 19;
    const playerHit = this.raycaster.ray.intersectSphere(_sphere, _point);
    // Visibility was already established by the enemy's cached decision.
    // A second full collision-tree raycast for every bullet was the largest
    // recurring main-thread stall in close combat.
    const hitPlayer = Boolean(playerHit);
    const end = hitPlayer
      ? playerHit.clone()
      : _origin.clone().addScaledVector(_direction, this.raycaster.far);
    this.weaponEffects?.addTracer(_origin.clone(), end);
    this.weaponEffects?.addMuzzleFlash(_origin, _direction);
    this.weaponEffects?.playEnemyShot(_origin, enemy.index);
    if (hitPlayer) this.playerHealth?.takeDamage(this.enemyDamage, enemy);
  }

  canEnemyFire(candidate) {
    return this.enemies
      .filter((enemy) => !enemy.dead && enemy.state === 'attack' && enemy.playerVisible)
      .sort((a, b) => a.root.position.distanceToSquared(this.player.position) -
        b.root.position.distanceToSquared(this.player.position))
      .slice(0, this.maxAttackers)
      .includes(candidate);
  }

  findPatrolPoint(origin) {
    const choices = this.patrolPoints.filter((point) => {
      const distance = planarDistance(point, origin);
      return distance > 220 && distance < 850;
    });
    if (choices.length === 0) return null;
    return choices[Math.floor(Math.random() * choices.length)].clone();
  }

  alert(origin, radius, lastSeen) {
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.root.position.distanceToSquared(origin) > radius * radius) continue;
      enemy.lastSeen.copy(lastSeen);
      enemy.lastSeenTimer = Math.max(enemy.lastSeenTimer, 3.5);
      enemy.decisionTimer = 0;
    }
  }

  respawnFor(enemy) {
    if (!enemy.spawnPoint) return { position: enemy.root.position.clone(), yaw: enemy.root.rotation.y };
    return {
      ...enemy.spawnPoint,
      position: enemy.spawnPoint.position.clone(),
      authoredPosition: enemy.spawnPoint.authoredPosition.clone(),
    };
  }

  update(deltaSeconds, { active = true } = {}) {
    for (const enemy of this.enemies) enemy.update(deltaSeconds, active);
  }

  dispose() {
    for (const enemy of this.enemies) {
      if (enemy.agent) this.navigation.crowd.removeAgent(enemy.agent);
      enemy.root.removeFromParent();
    }
    this.enemies.length = 0;
  }
}

export default EnemyManager;
