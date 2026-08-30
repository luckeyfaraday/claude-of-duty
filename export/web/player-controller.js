import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';

// A small, physics-only first-person controller.  The Octree is deliberately
// separate from the render scene: pass it the collision-only Object3D (or the
// loaded glTF scene when that is all that is available).
//
// Coordinates are Three.js coordinates (Y up).  The capsule's start/end are
// the centres of its bottom/top hemispheres, so `height` includes both caps.

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _movement = new THREE.Vector3();
const _translation = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _groundOrigin = new THREE.Vector3();
const _groundRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
const _candidateStart = new THREE.Vector3();
const _candidateEnd = new THREE.Vector3();
const _ladderWish = new THREE.Vector3();

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readButton(input, ...names) {
  for (const name of names) {
    if (input && input[name] !== undefined) return Boolean(input[name]);
  }
  return false;
}

function readAxis(input, positiveNames, negativeNames) {
  let value;
  for (const name of positiveNames) {
    if (input && input[name] !== undefined) {
      value = Number(input[name]) || 0;
      break;
    }
  }
  if (value === undefined) value = 0;
  for (const name of negativeNames) {
    if (input && input[name] !== undefined) {
      value -= Number(input[name]) || 0;
      break;
    }
  }
  return clamp(value, -1, 1);
}

function copyPosition(value, fallback) {
  if (value && value.isVector3) return value.clone();
  if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
    return new THREE.Vector3(value.x, value.y, value.z);
  }
  return fallback.clone();
}

function levelAxis(value, fallback) {
  const axis = new THREE.Vector3(
    Number(value?.[0] ?? value?.x) || 0,
    0,
    Number(value?.[2] ?? value?.z) || 0,
  );
  return axis.lengthSq() < 1e-8 ? fallback.clone() : axis.normalize();
}

/**
 * Normalise one baked ladder descriptor into the form the controller uses.
 *
 * A ladder is an upright box: `right` runs along the rungs, `normal` points out
 * of one climbing face, and both faces are climbable because the export carries
 * no hint about which side is bolted to a wall.
 */
export function createLadderVolume(descriptor) {
  if (!descriptor) return null;
  const center = copyPosition(
    Array.isArray(descriptor.center)
      ? { x: descriptor.center[0], y: descriptor.center[1], z: descriptor.center[2] }
      : descriptor.center,
    new THREE.Vector3(),
  );
  const right = levelAxis(descriptor.right, new THREE.Vector3(1, 0, 0));
  const normal = levelAxis(descriptor.normal, new THREE.Vector3(0, 0, 1));
  const halfWidth = Math.max(0, numberOr(descriptor.halfWidth, 16));
  const halfDepth = Math.max(0, numberOr(descriptor.halfDepth, 4));
  const bottom = numberOr(descriptor.bottom, center.y - 64);
  const top = numberOr(descriptor.top, center.y + 64);
  if (!(top > bottom)) return null;
  return { name: descriptor.name ?? 'ladder', center, right, normal, halfWidth, halfDepth, bottom, top };
}

/** Accepts a bare array of descriptors or the baked `{ volumes: [...] }` file. */
export function createLadderVolumes(source) {
  const list = Array.isArray(source) ? source : (source?.volumes ?? []);
  return list.map(createLadderVolume).filter(Boolean);
}

/**
 * Build an Octree from a collision Object3D.
 *
 * `Octree.fromGraphNode` applies each mesh's world matrix.  Call this after
 * the glTF has loaded and its transforms have been set.  A fresh tree is
 * returned on each call, which also makes rebuilding after a map change safe.
 */
export function buildCollisionOctree(collisionObject) {
  if (!collisionObject || typeof collisionObject.updateWorldMatrix !== 'function') {
    throw new TypeError('buildCollisionOctree requires a Three.js Object3D');
  }
  const octree = new Octree();
  octree.fromGraphNode(collisionObject);
  return octree;
}

export class PlayerController {
  /**
   * @param {THREE.Camera} camera camera whose world position is the eye
   * @param {THREE.Object3D|Octree|null} collisionSource collision Object3D or
   *        an already-built Octree
   * @param {object} options controller tuning and spawn options
   */
  constructor(camera, collisionSource = null, options = {}) {
    if (!camera || !camera.isCamera) {
      throw new TypeError('PlayerController requires a Three.js camera');
    }

    this.camera = camera;
    this.options = options;
    const sourceIsOctree = collisionSource && typeof collisionSource.capsuleIntersect === 'function';
    this.worldOctree = sourceIsOctree
      ? collisionSource
      : new Octree();
    this.collisionObject = null;
    this.worldReady = Boolean(sourceIsOctree);

    this.radius = Math.max(0.01, numberOr(options.radius, 16));
    this.height = Math.max(this.radius * 2 + 0.01, numberOr(options.height, 72));
    this.crouchHeight = clamp(
      numberOr(options.crouchHeight, 48),
      this.radius * 2 + 0.01,
      this.height,
    );
    this.eyeHeight = clamp(numberOr(options.eyeHeight, 60), this.radius, this.height);
    this.crouchEyeHeight = clamp(
      numberOr(options.crouchEyeHeight, 40),
      this.radius,
      this.crouchHeight,
    );

    this.gravity = Math.max(0, numberOr(options.gravity, 980));
    this.jumpHeight = Math.max(0, numberOr(options.jumpHeight, 110));
    this.jumpSpeed = Math.max(
      0,
      numberOr(options.jumpSpeed, Math.sqrt(2 * this.gravity * this.jumpHeight)),
    );
    this.moveSpeed = Math.max(0, numberOr(options.moveSpeed, 380));
    this.sprintSpeed = Math.max(0, numberOr(options.sprintSpeed, 900));
    this.crouchSpeed = Math.max(0, numberOr(options.crouchSpeed, 190));
    this.groundAcceleration = Math.max(0, numberOr(options.groundAcceleration, 2600));
    this.airAcceleration = Math.max(0, numberOr(options.airAcceleration, 900));
    this.maxFallSpeed = Math.max(0, numberOr(options.maxFallSpeed, 2600));
    this.groundSnapSpeed = Math.max(0, numberOr(options.groundSnapSpeed, 80));
    this.groundProbeDistance = Math.max(
      0.05,
      numberOr(options.groundProbeDistance, 1),
    );
    this.maxGroundProbeRiseSpeed = Math.max(
      0,
      numberOr(options.maxGroundProbeRiseSpeed, 10),
    );
    this.maxSlopeAngle = clamp(numberOr(options.maxSlopeAngle, 50), 0, 89.9);
    this.floorNormalY = Math.cos(THREE.MathUtils.degToRad(this.maxSlopeAngle));
    this.skin = Math.max(0.0001, numberOr(options.skin, 0.05));

    // A fixed step keeps collision results stable across frame rates.  The
    // default 120 Hz step is inexpensive for this map and handles thin walls.
    this.fixedTimeStep = clamp(numberOr(options.fixedTimeStep, 1 / 120), 1 / 300, 1 / 30);
    this.maxSubSteps = Math.max(1, Math.floor(numberOr(options.maxSubSteps, 8)));
    this.maxDelta = Math.max(this.fixedTimeStep, numberOr(options.maxDelta, 0.1));
    this.maxCollisionIterations = Math.max(
      1,
      Math.floor(numberOr(options.maxCollisionIterations, 5)),
    );
    this.maxCollisionStep = Math.max(
      0.25,
      numberOr(options.maxCollisionStep, this.radius * 0.25),
    );

    this.coyoteTime = Math.max(0, numberOr(options.coyoteTime, 0.1));
    this.jumpBufferTime = Math.max(0, numberOr(options.jumpBufferTime, 0.12));
    this.fallResetY = Number.isFinite(options.fallResetY) ? options.fallResetY : null;

    // Ladders are volumes rather than surfaces: the collision mesh only knows
    // the prop is solid, so climbing is driven entirely by these boxes.
    this.ladderClimbSpeed = Math.max(0, numberOr(options.ladderClimbSpeed, 180));
    this.ladderGripSpeed = Math.max(0, numberOr(options.ladderGripSpeed, 120));
    this.ladderReach = Math.max(0, numberOr(options.ladderReach, 12));
    this.ladderPushSpeed = Math.max(0, numberOr(options.ladderPushSpeed, 220));
    this.ladderExitSpeed = Math.max(0, numberOr(options.ladderExitSpeed, 220));
    this.ladderTopClearance = Math.max(0, numberOr(options.ladderTopClearance, 4));
    this.ladderExitTime = Math.max(0, numberOr(options.ladderExitTime, 0.3));
    // A ladder bolted flat against geometry can be mounted from the wrong face.
    // Rather than hang there weightless, let go once the climb stops making
    // progress it was asked to make.
    this.ladderStallTime = Math.max(0, numberOr(options.ladderStallTime, 0.4));
    // How squarely the player must be pushing at a face before they mount it,
    // so brushing past a ladder while strafing does not grab it.
    this.ladderMountBias = clamp(numberOr(options.ladderMountBias, 0.25), 0, 1);

    this.velocity = new THREE.Vector3();
    this.collider = new Capsule(new THREE.Vector3(), new THREE.Vector3(), this.radius);
    this.input = {
      forward: 0,
      strafe: 0,
      sprint: false,
      crouch: false,
      jump: false,
    };
    this.onFloor = false;
    this.grounded = false;
    this.crouched = false;
    this.onLadder = false;
    this.enabled = true;
    this._accumulator = 0;
    this._jumpBufferTimer = 0;
    this._coyoteTimer = 0;
    this._jumpHeld = false;
    this._collisionNormal = new THREE.Vector3(0, 1, 0);
    this._lastCollision = null;
    this.ladders = createLadderVolumes(options.ladders);
    this._ladder = null;
    this._ladderSide = 1;
    this._ladderExitTimer = 0;
    this._ladderStall = 0;

    if (collisionSource && !sourceIsOctree) {
      this.buildCollision(collisionSource);
    }

    // An omitted spawn is interpreted as the camera's current eye position so
    // a caller can construct the controller before choosing a map spawn.  An
    // explicit spawn is a feet position by default; use spawnIsEye for an eye
    // coordinate from a map marker.
    const hasExplicitSpawn = options.spawn !== undefined;
    const spawn = copyPosition(options.spawn, this.camera.position);
    const spawnIsEye = options.spawnIsEye === true || (!hasExplicitSpawn && options.spawnIsEye !== false);
    this.spawn = spawn.clone();
    this.spawnIsEye = spawnIsEye;
    this.reset(spawn, { eye: spawnIsEye, resolve: false });
  }

  /** Rebuild the static collision tree from an Object3D. */
  buildCollision(collisionObject) {
    this.collisionObject = collisionObject || null;
    this.worldOctree = buildCollisionOctree(collisionObject);
    this.worldReady = true;
    return this.worldOctree;
  }

  /** Replace the tree with a caller-built Octree. */
  setCollisionOctree(octree) {
    if (!octree || typeof octree.capsuleIntersect !== 'function') {
      throw new TypeError('setCollisionOctree requires a Three.js Octree');
    }
    this.worldOctree = octree;
    this.collisionObject = null;
    this.worldReady = true;
    return this;
  }

  /**
   * Install climbable ladder volumes.  Accepts the baked ladder file, a bare
   * array of descriptors, or already-normalised volumes.
   */
  setLadders(source) {
    this.ladders = createLadderVolumes(source);
    this._releaseLadder();
    this._ladderExitTimer = 0;
    return this;
  }

  /**
   * Change the respawn point.  By convention this is a feet position; pass
   * `{ eye: true }` when the supplied point is already a camera eye position.
   */
  setSpawn(position, { eye = false } = {}) {
    this.spawn = copyPosition(position, this.spawn);
    this.spawnIsEye = Boolean(eye);
    return this;
  }

  /**
   * Teleport and reset physics.  `position` defaults to the saved spawn.
   * Resolve is useful when a spawn marker is slightly inside map geometry.
   */
  reset(position = this.spawn, { eye = this.spawnIsEye, resolve = true } = {}) {
    const target = copyPosition(position, this.spawn);
    const feetY = eye ? target.y - this._eyeHeight : target.y;

    this.collider.start.set(target.x, feetY + this.radius, target.z);
    this.collider.end.set(target.x, feetY + this._segmentLength(this.height) + this.radius, target.z);
    this.velocity.set(0, 0, 0);
    this._accumulator = 0;
    this._jumpBufferTimer = 0;
    this._coyoteTimer = 0;
    this.crouched = false;
    this.onFloor = false;
    this.grounded = false;
    this._lastCollision = null;
    this._releaseLadder();
    this._ladderExitTimer = 0;

    if (resolve && this.worldReady) this._resolveOverlaps();
    this._syncCamera();
    return this;
  }

  /** Alias that reads naturally at a checkpoint or after falling off the map. */
  respawn(position = this.spawn, options = {}) {
    return this.reset(position, options);
  }

  /** Set movement input for the next fixed step(s). */
  setInput(input = {}) {
    if (!input) input = {};

    // A Vector2 `move` is accepted as (strafe, forward), while named axes and
    // key-style fields make direct integration with the existing viewer easy.
    const move = input.move && input.move.isVector2 ? input.move : null;
    const forward = move
      ? clamp(Number(move.y) || 0, -1, 1)
      : readAxis(input, ['forward', 'moveForward', 'KeyW', 'w'], ['backward', 'moveBackward', 'KeyS', 's']);
    const strafe = move
      ? clamp(Number(move.x) || 0, -1, 1)
      : readAxis(input, ['strafe', 'moveRight', 'right', 'KeyD', 'd'], ['moveLeft', 'left', 'KeyA', 'a']);

    const jump = readButton(input, 'jump', 'jumpPressed', 'Space', 'space');
    if (jump && !this._jumpHeld) this._jumpBufferTimer = this.jumpBufferTime;
    // `jumpPressed` explicitly means an edge, even if a caller does not keep
    // a held Space state in its input object.
    if (input.jumpPressed) this._jumpBufferTimer = this.jumpBufferTime;
    this._jumpHeld = jump && !input.jumpPressed;

    this.input.forward = forward;
    this.input.strafe = strafe;
    this.input.sprint = readButton(input, 'sprint', 'run', 'ShiftLeft', 'ShiftRight', 'shift');
    this.input.crouch = readButton(input, 'crouch', 'duck', 'ControlLeft', 'ControlRight', 'KeyC', 'c');
    this.input.jump = jump;
    return this;
  }

  /** Queue a jump without needing to synthesize a held input state. */
  jump() {
    this._jumpBufferTimer = this.jumpBufferTime;
    return this;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.velocity.set(0, 0, 0);
      this._accumulator = 0;
      this._releaseLadder();
    }
    return this;
  }

  /**
   * Advance the controller.  `input` is optional; when omitted, the previous
   * input remains active.  Returns a small state object for HUD/debug code.
   */
  update(deltaSeconds, input) {
    if (input !== undefined) this.setInput(input);
    if (!this.enabled) {
      this._syncCamera();
      return this.state;
    }

    const dt = clamp(numberOr(deltaSeconds, 0), 0, this.maxDelta);
    this._accumulator = Math.min(
      this._accumulator + dt,
      this.fixedTimeStep * this.maxSubSteps,
    );

    let steps = 0;
    while (this._accumulator >= this.fixedTimeStep && steps < this.maxSubSteps) {
      this._stepFixed(this.fixedTimeStep);
      this._accumulator -= this.fixedTimeStep;
      steps += 1;
    }

    this._syncCamera();
    return this.state;
  }

  /** Force one fixed simulation step, useful for deterministic tests. */
  step(deltaSeconds = this.fixedTimeStep) {
    if (!this.enabled) return this.state;
    this._stepFixed(clamp(numberOr(deltaSeconds, this.fixedTimeStep), 0, this.maxDelta));
    this._syncCamera();
    return this.state;
  }

  get state() {
    return {
      position: this.camera.position,
      feetPosition: this.feetPosition,
      velocity: this.velocity,
      grounded: this.onFloor,
      crouched: this.crouched,
      onLadder: this.onLadder,
      worldReady: this.worldReady,
    };
  }

  get isOnLadder() {
    return this.onLadder;
  }

  get position() {
    return this.camera.position;
  }

  get feetPosition() {
    return new THREE.Vector3(this.collider.start.x, this.collider.start.y - this.radius, this.collider.start.z);
  }

  get isGrounded() {
    return this.onFloor;
  }

  get eyeHeight() {
    return this.crouched ? this.crouchEyeHeight : this._standingEyeHeight;
  }

  set eyeHeight(value) {
    this._standingEyeHeight = clamp(numberOr(value, 60), this.radius, this.height);
  }

  get currentHeight() {
    return this.crouched ? this.crouchHeight : this.height;
  }

  _segmentLength(height) {
    return Math.max(0.01, height - 2 * this.radius);
  }

  get _eyeHeight() {
    return this.crouched ? this.crouchEyeHeight : this._standingEyeHeight;
  }

  _stepFixed(dt) {
    const wasOnFloor = this.onFloor;
    if (wasOnFloor) this._coyoteTimer = this.coyoteTime;
    else this._coyoteTimer = Math.max(0, this._coyoteTimer - dt);
    this._jumpBufferTimer = Math.max(0, this._jumpBufferTimer - dt);

    this._updateCrouchState();
    this._updateLadderState(dt);

    // A jump always leaves the ladder, pushing back off the face so the player
    // clears it instead of immediately re-grabbing.
    if (this.onLadder && this._jumpBufferTimer > 0) {
      this._detachLadder({ pushOff: this.ladderPushSpeed, hop: this.jumpSpeed * 0.6 });
      this._jumpBufferTimer = 0;
    }

    if (!this.onLadder && this._jumpBufferTimer > 0 && (this.onFloor || this._coyoteTimer > 0)) {
      this.velocity.y = this.jumpSpeed;
      this.onFloor = false;
      this.grounded = false;
      this._jumpBufferTimer = 0;
      this._coyoteTimer = 0;
    }

    if (this.onLadder) {
      this._updateLadderVelocity();
    } else {
      this._updateHorizontalVelocity(dt);
      if (this.onFloor) {
        // A small downward bias keeps the capsule attached to gently uneven
        // floors without allowing gravity to make it jitter through the mesh.
        if (this.velocity.y <= 0) this.velocity.y = -this.groundSnapSpeed;
      } else {
        this.velocity.y = Math.max(this.velocity.y - this.gravity * dt, -this.maxFallSpeed);
      }
    }

    // Octree.capsuleIntersect is an overlap test rather than a swept test.
    // Split unusually large translations so a fast sprint cannot pass
    // through a thin railing or wall between two fixed samples.
    const travel = this.velocity.length() * dt;
    const moveSteps = Math.max(1, Math.ceil(travel / this.maxCollisionStep));
    const moveDt = dt / moveSteps;
    _movement.copy(this.velocity).multiplyScalar(moveDt);
    const climbSpeedY = this.velocity.y;
    const previousFeetY = this.collider.start.y - this.radius;
    let groundedDuringMove = false;
    for (let i = 0; i < moveSteps; i += 1) {
      this.collider.translate(_movement);
      this._resolveCollisions();
      // Rung tops are walkable-facing triangles.  On a ladder they must not
      // arrest the climb the way a floor would.
      if (this.onLadder) this.velocity.y = climbSpeedY;
      groundedDuringMove = groundedDuringMove || this.onFloor;
    }

    if (this.onLadder) {
      this.onFloor = false;
      this.grounded = false;
      this._updateLadderExit(dt, previousFeetY);
    } else {
      // Keep a floor contact found by an earlier movement slice even if the
      // last slice only moved tangentially and generated no new overlap.
      if (!groundedDuringMove && this.velocity.y <= this.maxGroundProbeRiseSpeed) {
        groundedDuringMove = this._probeGround();
      }
      this.onFloor = groundedDuringMove;
      this.grounded = groundedDuringMove;
      if (groundedDuringMove && this.velocity.y < 0) this.velocity.y = 0;
    }

    if (this.fallResetY !== null && this.collider.start.y - this.radius < this.fallResetY) {
      this.reset(this.spawn, { eye: this.spawnIsEye, resolve: true });
    }
  }

  _updateHorizontalVelocity(dt) {
    this._wishDirection(_wish);

    const speed = this.crouched
      ? this.crouchSpeed
      : (this.input.sprint ? this.sprintSpeed : this.moveSpeed);
    _wish.multiplyScalar(speed);

    const acceleration = this.onFloor ? this.groundAcceleration : this.airAcceleration;
    const maxChange = acceleration * dt;
    this.velocity.x += clamp(_wish.x - this.velocity.x, -maxChange, maxChange);
    this.velocity.z += clamp(_wish.z - this.velocity.z, -maxChange, maxChange);
  }

  _updateCrouchState() {
    const wantCrouch = this.input.crouch;
    if (wantCrouch && !this.crouched) {
      this._setCapsuleHeight(this.crouchHeight);
      this.crouched = true;
      return;
    }
    if (!wantCrouch && this.crouched && this._canUseHeight(this.height)) {
      this._setCapsuleHeight(this.height);
      this.crouched = false;
    }
  }

  /** Flat wish direction from the current input, in world space. */
  _wishDirection(target) {
    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-8) _forward.set(0, 0, -1);
    else _forward.normalize();
    _right.crossVectors(_forward, this.camera.up);
    _right.y = 0;
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    else _right.normalize();

    target.set(0, 0, 0);
    target.addScaledVector(_forward, this.input.forward);
    target.addScaledVector(_right, this.input.strafe);
    if (target.lengthSq() > 1) target.normalize();
    return target;
  }

  /**
   * Where the capsule sits relative to a ladder, or null when out of reach.
   *
   * `across` is signed along the volume normal so `side` records which face the
   * player is climbing; `along` is the offset across the rungs.
   */
  _ladderContact(ladder) {
    if (!ladder) return null;
    const feetY = this.collider.start.y - this.radius;
    const headY = this.collider.end.y + this.radius;
    // Reach above the rails so a climber clears the lip under _updateLadderExit
    // rather than silently losing contact on the way up.
    if (headY < ladder.bottom || feetY > ladder.top + this.ladderTopClearance * 2) return null;

    const dx = this.collider.start.x - ladder.center.x;
    const dz = this.collider.start.z - ladder.center.z;
    const along = dx * ladder.right.x + dz * ladder.right.z;
    if (Math.abs(along) > ladder.halfWidth + this.radius) return null;

    const across = dx * ladder.normal.x + dz * ladder.normal.z;
    const standoff = ladder.halfDepth + this.radius;
    if (Math.abs(across) > standoff + this.ladderReach) return null;

    return { along, across, standoff, feetY, side: across >= 0 ? 1 : -1 };
  }

  /** Attach to, or drop off, a ladder before this step's movement is built. */
  _updateLadderState(dt) {
    this._ladderExitTimer = Math.max(0, this._ladderExitTimer - dt);

    if (this.onLadder) {
      // Strafing off the end of the rungs, or climbing out of the volume,
      // simply lets go.
      if (!this._ladderContact(this._ladder)) this._detachLadder();
      return;
    }

    if (this._ladderExitTimer > 0 || this.ladders.length === 0) return;

    this._wishDirection(_ladderWish);
    if (_ladderWish.lengthSq() < 1e-6) return;

    for (const ladder of this.ladders) {
      const contact = this._ladderContact(ladder);
      if (!contact) continue;
      // Nothing left to climb means this is a ledge to walk off, not a mount.
      if (ladder.top - contact.feetY < this.ladderTopClearance) continue;
      const into = -(_ladderWish.x * ladder.normal.x + _ladderWish.z * ladder.normal.z) * contact.side;
      if (into < this.ladderMountBias) continue;
      this.onLadder = true;
      this._ladder = ladder;
      this._ladderSide = contact.side;
      return;
    }
  }

  /**
   * Drive the climb.  Velocity is set outright rather than accelerated so the
   * ladder feels crisp, and because gravity is not integrated while attached.
   */
  _updateLadderVelocity() {
    const ladder = this._ladder;
    const side = this._ladderSide;
    this._wishDirection(_ladderWish);

    // Pushing at the face climbs, pulling away descends; sliding along the
    // rungs is how the player steps off sideways.
    const into = -(_ladderWish.x * ladder.normal.x + _ladderWish.z * ladder.normal.z) * side;
    const along = _ladderWish.x * ladder.right.x + _ladderWish.z * ladder.right.z;
    this.velocity.y = into * this.ladderClimbSpeed;

    // Close any remaining gap to the face, but never push into it once in
    // contact, which would fight the collision resolver and jitter the camera.
    const contact = this._ladderContact(ladder);
    const gap = contact ? Math.abs(contact.across) - contact.standoff : 0;
    const grip = gap > 0 ? Math.min(gap / this.fixedTimeStep, this.ladderGripSpeed) : 0;

    const strafe = along * this.ladderClimbSpeed * 0.5;
    this.velocity.x = ladder.right.x * strafe - ladder.normal.x * side * grip;
    this.velocity.z = ladder.right.z * strafe - ladder.normal.z * side * grip;
  }

  /** Leave the ladder once the player tops out, lands, or stops making headway. */
  _updateLadderExit(dt, previousFeetY) {
    const ladder = this._ladder;
    const feetY = this.collider.start.y - this.radius;

    // Geometry the volume knows nothing about — the wall behind a ladder, an
    // overhang at the top — can pin a climb in place.  Treat sustained failure
    // to move as a signal to let go.
    const wanted = Math.abs(this.velocity.y) * dt;
    if (wanted > 1e-4 && Math.abs(feetY - previousFeetY) < wanted * 0.25) {
      this._ladderStall += dt;
      if (this._ladderStall >= this.ladderStallTime) {
        this._detachLadder();
        return;
      }
    } else {
      this._ladderStall = 0;
    }

    if (this.velocity.y > 0 && feetY >= ladder.top + this.ladderTopClearance) {
      // Step over the lip away from the climbing face, where the surface the
      // ladder serves has to be, and let gravity settle the landing.
      this._detachLadder({ pushOff: -this.ladderExitSpeed });
      return;
    }
    // Let go once there is floor underfoot.  The rails usually stop a little
    // above the ground, and the capsule rests a skin width clear of it, so an
    // exact `feetY <= bottom` test would strand the player on the last rung.
    if (this.velocity.y < 0 && (feetY <= ladder.bottom || this._probeGround())) {
      this._detachLadder();
    }
  }

  /** Detach, optionally shoving the player off the face. */
  _detachLadder({ pushOff = 0, hop = 0 } = {}) {
    const ladder = this._ladder;
    const side = this._ladderSide;
    this._releaseLadder();
    this._ladderExitTimer = this.ladderExitTime;
    if (ladder && pushOff !== 0) {
      this.velocity.x = ladder.normal.x * side * pushOff;
      this.velocity.z = ladder.normal.z * side * pushOff;
    }
    if (hop !== 0) this.velocity.y = hop;
  }

  _releaseLadder() {
    this.onLadder = false;
    this._ladder = null;
    this._ladderStall = 0;
  }

  _setCapsuleHeight(height) {
    const feetY = this.collider.start.y - this.radius;
    this.collider.start.y = feetY + this.radius;
    this.collider.end.y = feetY + this._segmentLength(height) + this.radius;
  }

  _canUseHeight(height) {
    if (!this.worldReady) return true;
    const feetY = this.collider.start.y - this.radius;
    _candidateStart.set(this.collider.start.x, feetY + this.radius, this.collider.start.z);
    _candidateEnd.set(
      this.collider.end.x,
      feetY + this._segmentLength(height) + this.radius,
      this.collider.end.z,
    );
    const candidate = new Capsule(_candidateStart, _candidateEnd, this.radius);
    const result = this.worldOctree.capsuleIntersect(candidate);
    return !result || result.depth <= this.skin;
  }

  _resolveOverlaps() {
    for (let i = 0; i < this.maxCollisionIterations; i += 1) {
      const result = this.worldOctree.capsuleIntersect(this.collider);
      if (!result || result.depth <= this.skin) break;
      _normal.copy(result.normal).normalize();
      _translation.copy(_normal).multiplyScalar(result.depth + this.skin);
      this.collider.translate(_translation);
    }
    this._resolveCollisions(false);
  }

  /** Resolve penetration and project velocity along contact planes. */
  _resolveCollisions(updateGround = true) {
    let grounded = false;
    let bestGroundY = -1;
    this._lastCollision = null;

    if (!this.worldReady) {
      this.onFloor = false;
      this.grounded = false;
      return;
    }

    for (let i = 0; i < this.maxCollisionIterations; i += 1) {
      const result = this.worldOctree.capsuleIntersect(this.collider);
      if (!result || result.depth <= this.skin) break;

      _normal.copy(result.normal).normalize();
      const depth = Math.max(0, result.depth) + this.skin;
      _translation.copy(_normal).multiplyScalar(depth);
      this.collider.translate(_translation);
      this._lastCollision = result;

      if (_normal.y >= this.floorNormalY && _normal.y > bestGroundY) {
        grounded = true;
        bestGroundY = _normal.y;
        this._collisionNormal.copy(_normal);
      }

      // Remove only velocity directed into the surface.  The tangent remains,
      // which gives natural wall sliding and corner handling.
      const intoSurface = this.velocity.dot(_normal);
      if (intoSurface < 0) this.velocity.addScaledVector(_normal, -intoSurface);
    }

    if (updateGround) {
      this.onFloor = grounded;
      this.grounded = grounded;
      if (grounded && this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  /**
   * Confirm a nearby walkable floor independently from capsule penetration.
   * Near a floor/wall seam, Octree.capsuleIntersect can combine both contacts
   * into a wall-heavy normal. A short vertical ray avoids treating that as a
   * lost floor while still requiring actual geometry directly below the feet.
   */
  _probeGround() {
    if (!this.worldReady || typeof this.worldOctree.rayIntersect !== 'function') return false;

    const feetY = this.collider.start.y - this.radius;
    _groundOrigin.set(
      this.collider.start.x,
      feetY + this.groundProbeDistance,
      this.collider.start.z,
    );
    _groundRay.origin.copy(_groundOrigin);
    const hit = this.worldOctree.rayIntersect(_groundRay);
    if (!hit || hit.distance > this.groundProbeDistance + this.skin * 2) return false;

    hit.triangle.getNormal(_normal);
    if (_normal.y < this.floorNormalY) return false;
    this._collisionNormal.copy(_normal);
    return true;
  }

  _syncCamera() {
    const feetY = this.collider.start.y - this.radius;
    this.camera.position.set(this.collider.start.x, feetY + this._eyeHeight, this.collider.start.z);
  }
}

export default PlayerController;
