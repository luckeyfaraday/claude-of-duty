export class PlayerHealth {
  constructor({
    maxHealth = 100,
    respawnDelay = 2.5,
    spawnProtection = 0,
    regenDelay = 0,
    regenPerSecond = 0,
    onDamage = null,
    onDeath = null,
    onRespawn = null,
  } = {}) {
    this.maxHealth = Math.max(1, Number(maxHealth) || 100);
    this.respawnDelay = Math.max(0, Number(respawnDelay) || 0);
    this.spawnProtection = Math.max(0, Number(spawnProtection) || 0);
    this.regenDelay = Math.max(0, Number(regenDelay) || 0);
    this.regenPerSecond = Math.max(0, Number(regenPerSecond) || 0);
    this.onDamage = onDamage;
    this.onDeath = onDeath;
    this.onRespawn = onRespawn;
    this.health = this.maxHealth;
    this.dead = false;
    this.respawnTimer = 0;
    this.hitFlash = 0;
    this.protectionTimer = this.spawnProtection;
    this.regenTimer = 0;
  }

  takeDamage(amount, source = null) {
    const damage = Math.max(0, Number(amount) || 0);
    if (this.dead || this.protectionTimer > 0 || damage === 0) return 0;
    const applied = Math.min(this.health, damage);
    this.health -= applied;
    this.regenTimer = this.regenDelay;
    this.hitFlash = 1;
    this.onDamage?.({ amount: applied, health: this.health, source });
    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = this.respawnDelay;
      this.onDeath?.({ source });
    }
    return applied;
  }

  update(deltaSeconds) {
    const dt = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.25));
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.5);
    this.protectionTimer = Math.max(0, this.protectionTimer - dt);
    if (!this.dead) {
      this.regenTimer = Math.max(0, this.regenTimer - dt);
      if (this.regenTimer === 0 && this.regenPerSecond > 0) {
        this.health = Math.min(this.maxHealth, this.health + this.regenPerSecond * dt);
      }
      return;
    }
    this.respawnTimer = Math.max(0, this.respawnTimer - dt);
    if (this.respawnTimer === 0) this.respawn();
  }

  respawn() {
    this.health = this.maxHealth;
    this.dead = false;
    this.respawnTimer = 0;
    this.hitFlash = 0;
    this.protectionTimer = this.spawnProtection;
    this.regenTimer = 0;
    this.onRespawn?.();
  }
}

export default PlayerHealth;
