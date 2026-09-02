import * as THREE from 'three';

// Camera-space view bob: the stride nudges the eye and rolls it a little,
// heavier when sprinting. The camera is the gameplay truth for position and
// aim (the controller writes it, firing and look read it), so the offset is
// applied around the render only and restored straight after.

const WALK = Object.freeze({
  // Offsets in world units (inches), rotations in radians, at full walk speed.
  side: 0.28,
  rise: 0.36,
  roll: 0.005,
  pitch: 0.003,
});

const SPRINT = Object.freeze({
  // Multipliers on the walk values as sprintBlend rises. The stride also slows
  // by `slow`, matching the heavier footfall in the viewmodel bob.
  side: 2,
  rise: 1.7,
  roll: 2.6,
  pitch: 1.8,
  slow: 0.45,
  // Constant lean while sprinting: a small downward pitch reads as pushing
  // into the run.
  lean: 0.01,
});

// Ground contact drops for a few physics steps on every stair riser and lip,
// so the stride keeps going for this long after the last contact instead of
// stuttering on terrain.
const GROUND_GRACE = 0.25;

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

export class ViewBob {
  constructor() {
    this.bobTime = 0;
    this.bobAmp = 0;
    this.sprintBlend = 0;
    this.airTime = 0;
    this.offset = new THREE.Vector3();
    this.tilt = new THREE.Euler(0, 0, 0, 'YXZ');
    this._savedPosition = new THREE.Vector3();
    this._savedQuaternion = new THREE.Quaternion();
    this._tiltQuaternion = new THREE.Quaternion();
    this._worldOffset = new THREE.Vector3();
    this._applied = false;
  }

  update(dt, state = {}) {
    const speed = state.speed ?? 0;
    const grounded = state.grounded ?? true;
    const moving = Boolean(state.moving);
    const sprinting = Boolean(state.sprinting) && moving;

    this.sprintBlend = damp(this.sprintBlend, sprinting ? 1 : 0, 8, dt);
    const sprint = this.sprintBlend;

    // Same stride clock as the viewmodel bob so the gun and the eye agree.
    this.airTime = grounded ? 0 : this.airTime + dt;
    const movingGrounded = moving && this.airTime < GROUND_GRACE;
    const speedFactor = THREE.MathUtils.clamp(speed / 300, 0, 1.4);
    this.bobAmp = damp(this.bobAmp, movingGrounded ? speedFactor : 0, 8, dt);
    if (movingGrounded) this.bobTime += dt * (5.5 + 4 * speedFactor) * (1 - SPRINT.slow * sprint);

    const stride = Math.sin(this.bobTime);
    const step = Math.sin(this.bobTime * 2);
    const amp = this.bobAmp;
    const lerp = (walk, sprintScale) => walk * (1 + (sprintScale - 1) * sprint);

    this.offset.set(
      stride * lerp(WALK.side, SPRINT.side) * amp,
      // Footfalls dip rather than lift, so the rise is biased downward.
      (step - 0.5) * lerp(WALK.rise, SPRINT.rise) * amp,
      0,
    );
    this.tilt.set(
      step * lerp(WALK.pitch, SPRINT.pitch) * amp - SPRINT.lean * sprint,
      0,
      stride * lerp(WALK.roll, SPRINT.roll) * amp,
    );
  }

  // Push the bob onto the camera for a render. Call restore() afterwards.
  apply(camera) {
    if (this._applied) return;
    this._savedPosition.copy(camera.position);
    this._savedQuaternion.copy(camera.quaternion);
    this._applied = true;
    camera.position.add(this._worldOffset.copy(this.offset).applyQuaternion(camera.quaternion));
    this._tiltQuaternion.setFromEuler(this.tilt);
    camera.quaternion.multiply(this._tiltQuaternion);
  }

  restore(camera) {
    if (!this._applied) return;
    camera.position.copy(this._savedPosition);
    camera.quaternion.copy(this._savedQuaternion);
    this._applied = false;
  }
}
