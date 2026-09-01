export class WeaponController {
  constructor({
    magazineSize = 30,
    reserveAmmo = 120,
    roundsPerMinute = 750,
    initialRoundsPerMinute = null,
    initialShotCount = 0,
    onFire = null,
    onEmpty = null,
  } = {}) {
    if (!(magazineSize > 0)) throw new Error('magazineSize must be positive');
    if (!(roundsPerMinute > 0)) throw new Error('roundsPerMinute must be positive');
    if (initialShotCount > 0 && !(initialRoundsPerMinute > 0)) {
      throw new Error('initialRoundsPerMinute must be positive when initialShotCount is set');
    }

    this.magazineSize = Math.floor(magazineSize);
    this.magazine = this.magazineSize;
    this.startingReserveAmmo = Math.max(0, Math.floor(reserveAmmo));
    this.reserveAmmo = this.startingReserveAmmo;
    this.shotInterval = 60 / roundsPerMinute;
    this.initialShotInterval = initialShotCount > 0 ? 60 / initialRoundsPerMinute : null;
    this.initialShotCount = Math.max(0, Math.floor(initialShotCount));
    this.onFire = onFire;
    this.onEmpty = onEmpty;

    this.triggerHeld = false;
    this.reloading = false;
    this.cooldown = 0;
    this.fireCount = 0;
    this.emptyNotified = false;
    this.immediateShot = false;
    this.triggerShotCount = 0;
  }

  resetLoadout({ reserveAmmo = this.startingReserveAmmo } = {}) {
    this.magazine = this.magazineSize;
    this.reserveAmmo = Math.max(0, Math.floor(Number(reserveAmmo) || 0));
    this.triggerHeld = false;
    this.reloading = false;
    this.cooldown = 0;
    this.emptyNotified = false;
    this.immediateShot = false;
    this.triggerShotCount = 0;
    return { magazine: this.magazine, reserveAmmo: this.reserveAmmo };
  }

  get canReload() {
    return !this.reloading && this.magazine < this.magazineSize && this.reserveAmmo > 0;
  }

  setTrigger(held) {
    const next = Boolean(held);
    if (next && !this.triggerHeld) {
      this.immediateShot = true;
      this.triggerShotCount = 0;
    }
    if (!next) this.emptyNotified = false;
    this.triggerHeld = next;
  }

  startReload() {
    if (!this.canReload) return false;
    this.reloading = true;
    this.cooldown = 0;
    this.immediateShot = false;
    this.triggerShotCount = 0;
    return true;
  }

  finishReload() {
    if (!this.reloading) return 0;
    const loaded = Math.min(this.magazineSize - this.magazine, this.reserveAmmo);
    this.magazine += loaded;
    this.reserveAmmo -= loaded;
    this.reloading = false;
    this.emptyNotified = false;
    return loaded;
  }

  cancelReload() {
    this.reloading = false;
  }

  update(deltaSeconds, { canFire = true } = {}) {
    const dt = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.25));
    const shortestInterval = Math.min(this.shotInterval, this.initialShotInterval ?? this.shotInterval);
    this.cooldown = Math.max(-shortestInterval * 4, this.cooldown - dt);

    if (!this.triggerHeld || !canFire || this.reloading) return 0;
    if (this.immediateShot) {
      this.cooldown = 0;
      this.immediateShot = false;
    }

    let shots = 0;
    while (this.cooldown <= 0 && shots < 4) {
      if (this.magazine <= 0) {
        if (!this.emptyNotified) {
          this.emptyNotified = true;
          this.onEmpty?.();
        }
        break;
      }

      this.magazine -= 1;
      this.fireCount += 1;
      shots += 1;
      this.triggerShotCount += 1;
      const interval = this.initialShotInterval && this.triggerShotCount < this.initialShotCount
        ? this.initialShotInterval
        : this.shotInterval;
      this.cooldown += interval;
      this.onFire?.({
        fireCount: this.fireCount,
        triggerShotCount: this.triggerShotCount,
        magazine: this.magazine,
        reserveAmmo: this.reserveAmmo,
      });
    }
    return shots;
  }
}
