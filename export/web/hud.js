// In-game HUD drawn with the game's own art from `export/web/ui/hud/`
// (see .tools/export_hud.py). The layout is rebuilt in the browser -- T6
// menudefs do not dump -- so placement here approximates the shipped HUD:
// square minimap top left, compass tape under it, ammo bottom right, and the
// low-health vignette over the screen. T6 draws health through screen effects
// alone, so there is deliberately no health bar.

const ART = 'ui/hud/';

// World-to-radar calibration for `compass_map_mp_hijacked`. T6 stores the
// radar's world rect in the map asset, which does not survive the zone, so
// this is fitted by eye against landmarks (pool, bow, dive platform) and the
// navmesh extent of the yacht. The yacht's long axis is world X; the art
// draws it vertical. flipU/flipV resolve which way each world axis runs
// across the art; both were confirmed against rendered screenshots.
const MAP_CAL = {
  centerX: 1600,
  centerZ: 5,
  size: 2400,
  flipU: 1,
  flipV: -1,
  minimapSpan: 1250,
};

// `compass_mp_hud` is a 512x64 strip: one tick per 10 degrees and the
// cardinals a quarter turn apart, wrapping at the full texture width.
// Letter centres were measured from the art (N 9.5, E 136, S 265, W 392).
const TAPE = { width: 512, height: 64, period: 512, northCenter: 9.5 };

const VIEW = { minimap: 176, compassWidth: 264, compassHeight: 40 };
const FIRE_PING_SECONDS = 1.2;

const RAD2DEG = 180 / Math.PI;

function div(className, parent) {
  const element = document.createElement('div');
  element.className = className;
  parent.appendChild(element);
  return element;
}

export class Hud {
  constructor({
    minimap, compass, ammoRow, weaponName, damage,
  }) {
    this.minimap = minimap;
    this.damage = damage;
    this.weaponName = weaponName;

    this.rot = div('hud-minimap-rot', minimap);
    this.mapLayer = div('hud-minimap-map', this.rot);
    this.mapLayer.style.backgroundImage = `url('${ART}compass_map_mp_hijacked.png')`;
    this.arrow = div('hud-minimap-arrow', minimap);
    this.arrow.style.backgroundImage = `url('${ART}compassping_player.png')`;

    // One tape copy per wrap period keeps a cardinal in view for any heading.
    // Each copy clips itself to one period so neighbours never overpaint it.
    const tapeScale = VIEW.compassHeight / TAPE.height;
    this.tapePeriod = TAPE.period * tapeScale;
    this.tape = [];
    for (let i = 0; i < 3; i += 1) {
      const copy = div('hud-compass-tape', compass);
      copy.style.backgroundImage = `url('${ART}compass_mp_hud.png')`;
      copy.style.width = `${this.tapePeriod}px`;
      copy.style.backgroundSize = `${TAPE.width * tapeScale}px ${VIEW.compassHeight}px`;
      this.tape.push(copy);
    }

    this.ammoRow = ammoRow;
    this.magDigits = [];
    this.reserveDigits = [];
    for (let i = 0; i < 3; i += 1) this.magDigits.push(this.buildDigit());
    const divider = div('hud-digit hud-digit-divider', ammoRow);
    divider.style.backgroundImage = `url('${ART}hud_mp_num_big_line.png')`;
    for (let i = 0; i < 3; i += 1) {
      this.reserveDigits.push(this.buildDigit('hud-digit-reserve'));
    }

    // Pooled firing pings; an enemy lights at most one at a time.
    this.pings = [];
    this.firedAt = new Map();

    this.lastMag = null;
    this.lastReserve = null;
  }

  buildDigit(extraClass) {
    return div(extraClass ? `hud-digit ${extraClass}` : 'hud-digit', this.ammoRow);
  }

  // Called when enemy index fires so its map ping lights for a moment.
  markEnemyFire(index) {
    this.firedAt.set(index, performance.now());
  }

  setDigit(element, value) {
    const image = value === null ? 'none' : `url('${ART}hud_mp_num_big_${value}.png')`;
    if (element.dataset.image !== image) {
      element.style.backgroundImage = image;
      element.dataset.image = image;
    }
  }

  // Renders a number right-to-left into a digit pool; leading slots hide.
  renderNumber(pool, value) {
    const text = value === null ? '' : String(Math.max(0, Math.trunc(value)));
    for (let i = 0; i < pool.length; i += 1) {
      const fromRight = pool.length - 1 - i;
      const digit = fromRight < text.length ? Number(text[text.length - 1 - fromRight]) : null;
      this.setDigit(pool[i], digit);
      pool[i].style.visibility = fromRight < text.length ? '' : 'hidden';
    }
  }

  update({
    x, z, yaw, enemies, weapon, health, hitFlash, dead,
  }) {
    const heading = ((-yaw * RAD2DEG) % 360 + 360) % 360;

    // Compass tape: N centers at heading 0 and the strip advances one period
    // per revolution, so turning right scrolls the letters left.
    const tapeScale = this.tapePeriod / TAPE.period;
    const periodPx = this.tapePeriod;
    const base = VIEW.compassWidth / 2
      - (TAPE.northCenter + (heading / 360) * TAPE.period) * tapeScale;
    const wrapped = ((base % periodPx) + periodPx) % periodPx - periodPx;
    for (let i = 0; i < this.tape.length; i += 1) {
      this.tape[i].style.transform = `translateX(${(wrapped + i * periodPx).toFixed(1)}px)`;
    }

    // Minimap: the art spins about the player, who stays centred under a
    // fixed up-pointing arrow. `spin` is the clockwise rotation that brings
    // the facing direction to screen-up given the art's axis mapping.
    const mmScale = VIEW.minimap / MAP_CAL.minimapSpan;
    const mmSize = MAP_CAL.size * mmScale;
    // World facing is (-sin yaw, -cos yaw); art X runs along world Z and art
    // Y along world X, flipped per MAP_CAL.
    const artU = -Math.cos(yaw) * MAP_CAL.flipU;
    const artV = -Math.sin(yaw) * MAP_CAL.flipV;
    const spin = -Math.atan2(artU, -artV);
    this.rot.style.transform = `rotate(${spin.toFixed(4)}rad)`;
    this.mapLayer.style.width = `${mmSize}px`;
    this.mapLayer.style.height = `${mmSize}px`;
    this.mapLayer.style.backgroundSize = `${mmSize}px ${mmSize}px`;
    const px = mmSize / 2 + (z - MAP_CAL.centerZ) * MAP_CAL.flipU * mmScale;
    const py = mmSize / 2 + (x - MAP_CAL.centerX) * MAP_CAL.flipV * mmScale;
    this.mapLayer.style.left = `${VIEW.minimap / 2 - px}px`;
    this.mapLayer.style.top = `${VIEW.minimap / 2 - py}px`;

    const now = performance.now();
    let pingIndex = 0;
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      const firedAt = this.firedAt.get(enemy.index);
      if (firedAt === undefined) continue;
      const age = (now - firedAt) / 1000;
      if (age > FIRE_PING_SECONDS) continue;
      const ping = this.pings[pingIndex]
        ?? (this.pings[pingIndex] = div('hud-minimap-ping', this.mapLayer));
      ping.style.display = '';
      ping.style.opacity = (1 - age / FIRE_PING_SECONDS).toFixed(3);
      ping.style.left = `${px + (enemy.z - z) * MAP_CAL.flipU * mmScale - 8}px`;
      ping.style.top = `${py + (enemy.x - x) * MAP_CAL.flipV * mmScale - 8}px`;
      pingIndex += 1;
    }
    for (; pingIndex < this.pings.length; pingIndex += 1) {
      this.pings[pingIndex].style.display = 'none';
    }

    if (weapon.magazine !== this.lastMag) {
      this.renderNumber(this.magDigits, weapon.magazine);
      this.lastMag = weapon.magazine;
    }
    if (weapon.reserveAmmo !== this.lastReserve) {
      this.renderNumber(this.reserveDigits, weapon.reserveAmmo);
      this.lastReserve = weapon.reserveAmmo;
    }
    this.weaponName.textContent = weapon.ready ? 'M27' : '';

    // Damage: the hit flash rides the same vignette art the game fades in as
    // health drops, so a hard hit reads as a pulse of the low-health state.
    const lowHealth = health < 40 && !dead ? (1 - health / 40) * 0.9 : 0;
    const opacity = Math.max(hitFlash * 0.55, lowHealth);
    if (this.damage.dataset.opacity !== opacity.toFixed(3)) {
      this.damage.style.opacity = opacity.toFixed(3);
      this.damage.dataset.opacity = opacity.toFixed(3);
    }
  }
}
