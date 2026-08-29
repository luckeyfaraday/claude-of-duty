import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const browserPath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => fs.existsSync(candidate));
const browserTestUrl = process.env.BROWSER_TEST_URL ?? 'http://127.0.0.1:8000/';

test('Hijacked viewer loads collision, navigation, and walking controls', { timeout: 180_000 }, async () => {
  assert.ok(browserPath, 'Chrome or Edge is required for the browser smoke test');
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    const response = await page.goto(browserTestUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    assert.equal(response?.status(), 200);
    await page.locator('#blocker.ready').waitFor({ state: 'visible', timeout: 150_000 });
    const instructions = await page.locator('#blocker').innerText();
    assert.match(instructions, /Click to play/);
    assert.doesNotMatch(instructions, /failed/i);

    const simulation = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const before = api.player.feetPosition.clone();
      for (let i = 0; i < 120; i += 1) api.player.update(1 / 120, { forward: true });
      const after = api.player.feetPosition;
      const projection = api.navigation?.projectPoint(after);
      return {
        worldReady: api.player.worldReady,
        grounded: api.player.isGrounded,
        moved: Math.hypot(after.x - before.x, after.z - before.z),
        navProjected: projection?.success ?? false,
      };
    });
    assert.equal(simulation.worldReady, true);
    assert.equal(simulation.grounded, true);
    assert.ok(simulation.moved > 1, `expected capsule movement, got ${simulation.moved}`);
    assert.equal(simulation.navProjected, true);

    const viewmodel = await page.evaluate(() => {
      const v = globalThis.hijacked.viewmodel;
      if (!v?.ready) return { ready: false };
      const muzzle = v.muzzlePosition();
      return { ready: true, muzzle: [muzzle.x, muzzle.y, muzzle.z].map((n) => Number(n.toFixed(1))) };
    });
    assert.equal(viewmodel.ready, true, 'weapon viewmodel should be loaded');
    assert.ok(viewmodel.muzzle[2] < 0, `muzzle should point ahead of the camera, got ${viewmodel.muzzle}`);
    assert.ok(Math.abs(viewmodel.muzzle[0]) < 12, `weapon should be roughly centered, got ${viewmodel.muzzle}`);

    const enemySetup = await page.evaluate(() => {
      const api = globalThis.hijacked;
      return {
        count: api.enemies?.enemies.length ?? 0,
        alive: api.enemies?.aliveCount ?? 0,
        crowdAgents: api.navigation?.crowd?.getActiveAgentCount() ?? 0,
        hitboxes: api.enemies?.hitTargets.length ?? 0,
        models: api.enemies?.enemies.map((enemy) => Boolean(enemy.body && enemy.weapon)) ?? [],
        groundedRoots: api.enemies?.enemies.map((enemy) => {
          const rootBone = enemy.body.getObjectByName('j_mainroot');
          return rootBone ? Number(rootBone.position.z.toFixed(2)) : null;
        }) ?? [],
        weaponMountErrors: api.enemies?.enemies.map((enemy) => {
          enemy.root.updateMatrixWorld(true);
          const hand = enemy.handMount.getWorldPosition(enemy.root.position.clone());
          const mount = enemy.weaponMount.getWorldPosition(enemy.root.position.clone());
          return hand.distanceTo(mount);
        }) ?? [],
        weaponForwardDots: api.enemies?.enemies.map((enemy) => {
          enemy.root.updateMatrixWorld(true);
          const hand = enemy.handMount.getWorldPosition(enemy.root.position.clone());
          const muzzle = enemy.muzzle.getWorldPosition(enemy.root.position.clone()).sub(hand).normalize();
          const rootPosition = enemy.root.getWorldPosition(hand.clone());
          const forward = enemy.root.localToWorld(hand.clone().set(0, 0, -1))
            .sub(rootPosition).normalize();
          return muzzle.dot(forward);
        }) ?? [],
        animatedBodies: api.enemies?.enemies.map((enemy) => {
          const beforeBody = enemy.body;
          const beforeWrist = beforeBody.getObjectByName('j_wrist_ri').quaternion.clone();
          enemy.playAction('run');
          enemy.advanceVisual(0.25);
          const afterWrist = enemy.body.getObjectByName('j_wrist_ri').quaternion;
          const changed = 1 - Math.abs(beforeWrist.dot(afterWrist));
          const changedFrame = beforeBody !== enemy.body;
          enemy.playAction('idle');
          return { changed, changedFrame };
        }) ?? [],
        skinnedMeshCounts: api.enemies?.enemies.map((enemy) => {
          let count = 0;
          Object.values(enemy.visualFrames).flat().forEach((frame) => {
            frame.body.traverse((object) => { if (object.isSkinnedMesh) count += 1; });
          });
          return count;
        }) ?? [],
        activeMeshCounts: api.enemies?.enemies.map((enemy) => {
          let count = 0;
          enemy.body.traverse((object) => { if (object.isMesh) count += 1; });
          return count;
        }) ?? [],
        attachedPoseCounts: api.enemies?.enemies.map((enemy) => enemy.modelRoot.children.length) ?? [],
        sharedRunGeometry: (() => {
          const [first, second] = api.enemies?.enemies ?? [];
          if (!first || !second) return false;
          let firstMesh = null;
          let secondMesh = null;
          first.visualFrames.run[0].body.traverse((object) => { if (!firstMesh && object.isMesh) firstMesh = object; });
          second.visualFrames.run[0].body.traverse((object) => { if (!secondMesh && object.isMesh) secondMesh = object; });
          return firstMesh?.geometry === secondMesh?.geometry;
        })(),
        renderPixelRatio: api.renderer.getPixelRatio(),
        renderPixels: api.renderer.getContext().drawingBufferWidth *
          api.renderer.getContext().drawingBufferHeight,
        combatBalance: {
          damage: api.enemies.enemyDamage,
          shotInterval: api.enemies.enemyShotInterval,
          burstShots: [api.enemies.burstShotMin, api.enemies.burstShotMax],
          reaction: [api.enemies.reactionTimeMin, api.enemies.reactionTimeMax],
          magazine: api.enemies.enemyMagazineSize,
        },
        spawnClasses: api.enemies?.enemies.map((enemy) => enemy.spawnPoint.classname) ?? [],
        spawnMarkerIndices: api.enemies?.enemies.map((enemy) => enemy.spawnPoint.markerIndex) ?? [],
        spawnAssignmentErrors: api.enemies?.enemies.map((enemy) =>
          enemy.root.position.distanceTo(enemy.spawnPoint.position)) ?? [],
        spawnDistancesFromPlayer: api.enemies?.enemies.map((enemy) =>
          Math.hypot(
            enemy.spawnPoint.authoredPosition.x - api.player.feetPosition.x,
            enemy.spawnPoint.authoredPosition.z - api.player.feetPosition.z,
          )) ?? [],
        respawnAssignmentErrors: api.enemies?.enemies.map((enemy) =>
          api.enemies.respawnFor(enemy).position.distanceTo(enemy.spawnPoint.position)) ?? [],
        navProjected: api.enemies?.enemies.every((enemy) =>
          api.navigation.projectPoint(enemy.root.position).success) ?? false,
      };
    });
    assert.equal(enemySetup.count, 6, 'six enemies should spawn');
    assert.equal(enemySetup.alive, 6, 'all enemies should start alive');
    assert.equal(enemySetup.crowdAgents, 6, 'each enemy should own a crowd agent');
    assert.equal(enemySetup.hitboxes, 18, 'each enemy should expose three hitboxes');
    assert.equal(enemySetup.navProjected, true, 'enemy spawns should lie on the navmesh');
    assert.deepEqual(enemySetup.models, Array(6).fill(true), 'enemy body and weapon assets should load');
    assert.ok(enemySetup.groundedRoots.every((z) => Math.abs(z - 37.23) < 0.1),
      `enemy animation roots should retain the grounded bind height: ${enemySetup.groundedRoots}`);
    assert.ok(enemySetup.weaponMountErrors.every((error) => error < 0.01),
      `enemy weapons should remain attached to the right hand: ${enemySetup.weaponMountErrors}`);
    assert.ok(enemySetup.weaponForwardDots.every((dot) => dot > 0.98),
      `enemy weapon barrels should face with their actors: ${enemySetup.weaponForwardDots}`);
    assert.ok(enemySetup.animatedBodies.every(({ changed, changedFrame }) => changedFrame && changed > 0.0001),
      `enemy run clips should animate their skeletons: ${JSON.stringify(enemySetup.animatedBodies)}`);
    assert.deepEqual(enemySetup.skinnedMeshCounts, Array(6).fill(0),
      `enemy pose frames should not require GPU skinning: ${enemySetup.skinnedMeshCounts}`);
    assert.deepEqual(enemySetup.activeMeshCounts, Array(6).fill(2),
      `each enemy should render as one body mesh plus one weapon mesh: ${enemySetup.activeMeshCounts}`);
    assert.deepEqual(enemySetup.attachedPoseCounts, Array(6).fill(1),
      `only the active pose should participate in scene updates: ${enemySetup.attachedPoseCounts}`);
    assert.equal(enemySetup.sharedRunGeometry, true, 'enemies should share baked run-pose geometry');
    assert.ok(enemySetup.renderPixelRatio <= 1, `render scale should favor responsiveness: ${enemySetup.renderPixelRatio}`);
    assert.ok(enemySetup.renderPixels <= 1600 * 900,
      `drawing buffer should stay within its pixel budget: ${enemySetup.renderPixels}`);
    assert.deepEqual(enemySetup.combatBalance, {
      damage: 3,
      shotInterval: 0.16,
      burstShots: [2, 4],
      reaction: [0.35, 0.95],
      magazine: 24,
    });
    assert.deepEqual(enemySetup.spawnClasses, Array(6).fill('mp_tdm_spawn_team2_start'),
      `enemies should use the authored opposing-team starts: ${enemySetup.spawnClasses}`);
    assert.equal(new Set(enemySetup.spawnMarkerIndices).size, 6, 'each enemy should own a distinct spawn marker');
    assert.ok(enemySetup.spawnAssignmentErrors.every((error) => error < 0.01),
      `enemies should begin on their assigned spawn markers: ${enemySetup.spawnAssignmentErrors}`);
    assert.ok(enemySetup.spawnDistancesFromPlayer.every((distance) => distance > 4000),
      `enemy starts should be at the opposing end of the map: ${enemySetup.spawnDistancesFromPlayer}`);
    assert.ok(enemySetup.respawnAssignmentErrors.every((error) => error < 0.01),
      `enemies should respawn at their own markers: ${enemySetup.respawnAssignmentErrors}`);

    const cachedVisibility = await page.evaluate(() => {
      const manager = globalThis.hijacked.enemies;
      const enemy = manager.enemies[0];
      const original = manager.canSeePlayer;
      let calls = 0;
      manager.canSeePlayer = (...args) => {
        calls += 1;
        return original.apply(manager, args);
      };
      enemy.state = 'attack';
      enemy.playerVisible = false;
      enemy.decisionTimer = 10;
      const shotsBefore = enemy.shotsFired;
      enemy.update(1 / 60, true);
      manager.canSeePlayer = original;
      enemy.state = 'patrol';
      enemy.decisionTimer = 0;
      return { calls, didNotFire: enemy.shotsFired === shotsBefore };
    });
    assert.equal(cachedVisibility.calls, 0, 'attack ticks should use cached visibility instead of raycasting every frame');
    assert.equal(cachedVisibility.didNotFire, true, 'enemies without cached visibility should not fire');

    const uncappedFire = await page.evaluate(() => {
      const manager = globalThis.hijacked.enemies;
      const originalBlockCheck = manager.hasFriendlyLineBlock;
      manager.hasFriendlyLineBlock = () => false;
      manager.enemies.forEach((enemy) => {
        enemy.state = 'attack';
        enemy.playerVisible = true;
      });
      const allowed = manager.enemies.filter((enemy) => manager.canEnemyFire(enemy)).length;
      manager.hasFriendlyLineBlock = originalBlockCheck;
      manager.enemies.forEach((enemy) => {
        enemy.state = 'patrol';
        enemy.playerVisible = false;
        enemy.decisionTimer = 0;
      });
      return allowed;
    });
    assert.equal(uncappedFire, 6, 'every enemy with visibility and a clear firing line should be allowed to shoot');

    const friendlyLine = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const manager = api.enemies;
      const [shooter, blocker, ...others] = manager.enemies;
      const originalPositions = manager.enemies.map((enemy) => enemy.root.position.clone());
      const feet = api.player.feetPosition;
      shooter.root.position.set(feet.x - 500, feet.y, feet.z);
      blocker.root.position.set(feet.x - 250, feet.y, feet.z);
      others.forEach((enemy, index) => {
        enemy.root.position.set(feet.x - 450 + index * 20, feet.y, feet.z + 500 + index * 50);
      });
      manager.enemies.forEach((enemy) => enemy.root.updateMatrixWorld(true));
      const blocked = manager.hasFriendlyLineBlock(shooter);
      blocker.root.position.z += 100;
      blocker.root.updateMatrixWorld(true);
      const cleared = !manager.hasFriendlyLineBlock(shooter);
      manager.enemies.forEach((enemy, index) => {
        enemy.root.position.copy(originalPositions[index]);
        enemy.root.updateMatrixWorld(true);
      });
      return { blocked, cleared };
    });
    assert.deepEqual(friendlyLine, { blocked: true, cleared: true },
      'an enemy should hold fire only while a teammate physically crosses its shot line');

    const naturalCadence = await page.evaluate(() => {
      const manager = globalThis.hijacked.enemies;
      const enemy = manager.enemies[0];
      const originalCanFire = manager.canEnemyFire;
      const originalFire = manager.enemyFire;
      let fired = 0;
      manager.canEnemyFire = () => true;
      manager.enemyFire = () => { fired += 1; };
      enemy.state = 'attack';
      enemy.playerVisible = true;
      enemy.reactionTimer = 0.4;
      enemy.burstPauseTimer = 0;
      enemy.reloadTimer = 0;
      enemy.fireTimer = 0;
      enemy.magazine = 2;
      enemy.burstShotsRemaining = 2;
      enemy.updateWeapon(0.2);
      const waitedForReaction = fired === 0;
      enemy.updateWeapon(0.2);
      enemy.fireTimer = 0;
      enemy.updateWeapon(0);
      const result = {
        waitedForReaction,
        fired,
        magazine: enemy.magazine,
        reloading: enemy.reloadTimer > 0,
      };
      manager.canEnemyFire = originalCanFire;
      manager.enemyFire = originalFire;
      enemy.spawnAt(enemy.spawnPoint);
      return result;
    });
    assert.equal(naturalCadence.waitedForReaction, true, 'newly acquired targets should have a reaction delay');
    assert.equal(naturalCadence.fired, 2, 'enemies should fire short bursts when their line is clear');
    assert.equal(naturalCadence.magazine, 0, 'enemy shots should consume their own magazine');
    assert.equal(naturalCadence.reloading, true, 'an empty enemy magazine should force a reload pause');

    const searchBehavior = await page.evaluate(() => {
      const manager = globalThis.hijacked.enemies;
      const enemy = manager.enemies[0];
      const originalVisibility = manager.canSeePlayer;
      manager.canSeePlayer = () => false;
      enemy.engaged = true;
      enemy.state = 'chase';
      enemy.lastSeen.copy(globalThis.hijacked.player.position);
      enemy.lastSeenTimer = 0;
      enemy.searchTimer = 0;
      enemy.decide();
      const searching = {
        state: enemy.state,
        timer: enemy.searchTimer,
        hasTarget: Boolean(enemy.searchTarget),
      };
      enemy.searchTimer = 0;
      enemy.decide();
      const finishedState = enemy.state;
      manager.canSeePlayer = originalVisibility;
      enemy.spawnAt(enemy.spawnPoint);
      return { searching, finishedState };
    });
    assert.equal(searchBehavior.searching.state, 'search', 'an enemy should search after losing its memory target');
    assert.ok(searchBehavior.searching.timer > 0, 'searching should last for a deliberate time window');
    assert.equal(searchBehavior.searching.hasTarget, true, 'searchers should investigate a nearby navigation point');
    assert.equal(searchBehavior.finishedState, 'patrol', 'an exhausted search should return to patrol');

    const enemyDamage = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const enemy = api.enemies.enemies[0];
      const before = enemy.health;
      const handled = api.enemies.handlePlayerHit({ object: enemy.hitboxes[1] }, 34);
      const missed = api.enemies.handlePlayerHit({ object: { userData: {} } }, 34);
      return {
        region: handled?.region,
        damage: handled?.damage,
        killed: handled?.killed,
        missed,
        before,
        after: enemy.health,
        state: enemy.state,
        suppressionTimer: enemy.suppressionTimer,
      };
    });
    assert.equal(enemyDamage.region, 'head', 'enemy hitboxes should report which zone was struck');
    assert.equal(enemyDamage.damage, 68, 'head hitbox should double damage');
    assert.equal(enemyDamage.killed, false, 'one headshot should not kill a full-health enemy');
    assert.equal(enemyDamage.missed, null, 'a hit on nothing should report no damage');
    assert.equal(enemyDamage.before - enemyDamage.after, 68, 'head hitbox should double damage');
    assert.equal(enemyDamage.state, 'chase', 'a surviving hit should alert the enemy');
    assert.ok(enemyDamage.suppressionTimer > 0, 'a hit should temporarily reduce enemy accuracy');

    const combatFeedback = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const effects = api.weaponEffects;
      const enemy = api.enemies.enemies[1];
      enemy.root.updateMatrixWorld(true);

      // Drive one enemy shot through the real firing path and watch the world
      // flash pool and the panner cache it is supposed to drive.
      const beforeFlashes = effects.flashes.filter((flash) => flash.life > 0).length;
      const beforePanners = effects.audio.panners.size;
      api.enemies.enemyFire(enemy);
      const litFlash = effects.flashes.find((flash) => flash.life > 0 && flash.sprite.visible);
      const muzzle = enemy.muzzlePosition();

      effects.updateListener(api.camera);
      const listener = effects.audio.listenerPosition.clone();
      const cameraPosition = api.camera.getWorldPosition(listener.clone());

      // Flashes must expire on their own rather than accumulating in the scene.
      effects.update(1);
      return {
        beforeFlashes,
        flashLit: Boolean(litFlash),
        flashDistanceToMuzzle: litFlash ? litFlash.sprite.position.distanceTo(muzzle) : -1,
        pannersAdded: effects.audio.panners.size - beforePanners,
        listenerTracksCamera: listener.distanceTo(cameraPosition),
        clearedAfterUpdate: effects.flashes.every((flash) => flash.life === 0 && !flash.sprite.visible),
      };
    });
    assert.equal(combatFeedback.beforeFlashes, 0, 'no world muzzle flash should be lit before an enemy fires');
    assert.equal(combatFeedback.flashLit, true, 'an enemy shot should light a pooled world muzzle flash');
    assert.ok(combatFeedback.flashDistanceToMuzzle >= 0 && combatFeedback.flashDistanceToMuzzle < 12,
      `the flash should sit on the shooter's muzzle, got ${combatFeedback.flashDistanceToMuzzle}`);
    assert.equal(combatFeedback.pannersAdded, 1, 'an enemy shot should allocate exactly one reusable panner');
    assert.ok(combatFeedback.listenerTracksCamera < 0.01,
      `the audio listener should sit on the camera, got ${combatFeedback.listenerTracksCamera}`);
    assert.equal(combatFeedback.clearedAfterUpdate, true, 'muzzle flashes should expire back into the pool');

    const hitmarker = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const enemy = api.enemies.enemies[2];
      const element = document.getElementById('hitmarker');
      const readings = [];
      const record = (label) => readings.push({
        label,
        kind: element.dataset.kind,
        opacity: Number(element.style.opacity || 0),
      });

      // showHitmarker is driven from fireShot, so exercise it the same way the
      // game does: aim the camera at a hitbox and pull the trigger. The stand
      // is picked at run time because a fixed offset can end up inside the
      // yacht's geometry, which would stop the round short of the target.
      const shootAt = (hitbox) => {
        enemy.root.updateMatrixWorld(true);
        for (const offset of [[0, 45, 70], [0, 45, -70], [70, 45, 0], [-70, 45, 0], [0, 100, 40]]) {
          api.camera.position.set(
            enemy.root.position.x + offset[0],
            enemy.root.position.y + offset[1],
            enemy.root.position.z + offset[2],
          );
          api.camera.lookAt(hitbox.getWorldPosition(api.camera.position.clone()));
          api.weapon.magazine = 30;
          api.weapon.setTrigger(true);
          api.weapon.update(1 / 60, { canFire: true });
          api.weapon.setTrigger(false);
          if (api.weaponEffects.lastHit?.object?.userData?.enemyHit?.enemy === enemy) return true;
        }
        return false;
      };

      const bodyLanded = shootAt(enemy.hitboxes[0]);
      record('torso');
      enemy.health = 1;
      const killLanded = shootAt(enemy.hitboxes[0]);
      record('kill');
      return { readings, bodyLanded, killLanded, dead: enemy.dead };
    });
    assert.equal(hitmarker.bodyLanded, true, 'the test shot should reach the enemy torso hitbox');
    assert.equal(hitmarker.killLanded, true, 'the finishing shot should reach the enemy torso hitbox');
    assert.equal(hitmarker.dead, true, 'the finishing round should kill the enemy');
    assert.deepEqual(hitmarker.readings.map((reading) => reading.kind), ['torso', 'kill'],
      `hitmarker should distinguish a body hit from a kill: ${JSON.stringify(hitmarker.readings)}`);

    const audio = await page.evaluate(() => {
      const gunAudio = globalThis.hijacked.weaponEffects.audio;
      return {
        ready: gunAudio.ready,
        layers: Object.keys(gunAudio.buffers).sort(),
        durations: Object.fromEntries(
          Object.entries(gunAudio.buffers).map(([name, buffer]) => [name, Number(buffer.duration.toFixed(3))]),
        ),
      };
    });
    assert.equal(audio.ready, true, 'authentic weapon audio should be decoded before play');
    assert.deepEqual(audio.layers, ['exteriorDecay', 'interiorDecay', 'lfe', 'shot']);
    assert.ok(audio.durations.shot > 1.1 && audio.durations.shot < 1.2);

    const firing = await page.evaluate(() => {
      const api = globalThis.hijacked;
      const beforeAmmo = api.weapon.magazine;
      const beforeShots = api.weaponEffects.shotCount;
      api.weapon.setTrigger(true);
      const fired = api.weapon.update(1 / 120);
      api.weapon.setTrigger(false);
      return {
        fired,
        ammoUsed: beforeAmmo - api.weapon.magazine,
        effects: api.weaponEffects.shotCount - beforeShots,
        flashStarted: api.viewmodel.flashTime > 0,
      };
    });
    assert.equal(firing.fired, 1, 'trigger should fire immediately');
    assert.equal(firing.ammoUsed, 1, 'shot should consume one round');
    assert.equal(firing.effects, 1, 'shot should create weapon effects');
    assert.equal(firing.flashStarted, true, 'shot should start the muzzle flash');

    await page.locator('#blocker').click({ force: true });
    await page.waitForTimeout(250);
    const beforeInputShots = await page.evaluate(() => globalThis.hijacked.weaponEffects.shotCount);
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(100);
    const inputState = await page.evaluate((before) => ({
      bodyLocked: document.body.classList.contains('locked'),
      pointerLocked: Boolean(document.pointerLockElement),
      triggerHeld: globalThis.hijacked.weapon.triggerHeld,
      shots: globalThis.hijacked.weaponEffects.shotCount - before,
    }), beforeInputShots);
    assert.equal(inputState.bodyLocked, true, `body should reflect pointer lock: ${JSON.stringify(inputState)}`);
    assert.equal(inputState.pointerLocked, true, `canvas should hold pointer lock: ${JSON.stringify(inputState)}`);
    assert.equal(inputState.triggerHeld, true, `left mouse should hold the trigger: ${JSON.stringify(inputState)}`);

    // Headless Chromium can pause requestAnimationFrame even with its timer
    // throttles disabled. Advance the weapon once explicitly after proving the
    // real pointer-lock mouse event set the trigger, then render that shot.
    const inputShot = await page.evaluate((before) => {
      const api = globalThis.hijacked;
      const alreadyFired = api.weaponEffects.shotCount - before;
      const fired = alreadyFired > 0 ? 0 : api.weapon.update(1 / 60, { canFire: true });
      api.renderer.clear();
      api.renderer.render(api.scene, api.camera);
      api.viewmodel.render(api.renderer);
      return { fired, shots: api.weaponEffects.shotCount - before };
    }, beforeInputShots);
    await page.screenshot({ path: path.join(os.tmpdir(), 'hijacked-firing.png') });
    await page.mouse.up({ button: 'left' });
    assert.ok(inputShot.shots >= 1, 'held mouse trigger should fire through the real or explicit game tick');
    await page.keyboard.press('KeyN');
    await page.keyboard.press('KeyV');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(200);

    const reload = await page.evaluate(async () => {
      const api = globalThis.hijacked;
      const viewmodel = api.viewmodel;
      const beforeReserve = api.weapon.reserveAmmo;

      // Record the cues the running clip fires, and confirm each one reaches
      // the audio engine with a decoded buffer behind it.
      const cues = [];
      const played = [];
      const originalNotetrack = viewmodel.onNotetrack;
      const originalFoley = api.weaponEffects.playFoley.bind(api.weaponEffects);
      viewmodel.onNotetrack = (cue) => {
        cues.push({ type: cue.type, name: cue.name, at: Number(viewmodel.notetrackAction.time.toFixed(2)) });
        originalNotetrack(cue);
      };
      api.weaponEffects.playFoley = (name) => {
        const ok = originalFoley(name);
        played.push({ name, ok });
        return ok;
      };

      // The magazine is an attachment model driven by the clip's tag_clip
      // track, so a working reload physically moves it out of the magwell.
      const clip = viewmodel.root.getObjectByName('tag_clip');
      const rest = clip?.position.clone() ?? null;
      // Idle never animates tag_clip, so this is the attachment's bind pose.
      const bindQuat = clip?.quaternion.clone() ?? null;
      let magTravel = 0;
      let magSwing = 0;

      const started = api.reloadWeapon();
      const mid = viewmodel.reloading;
      await new Promise((resolve) => {
        const check = () => {
          if (clip && rest) {
            magTravel = Math.max(magTravel, clip.position.distanceTo(rest));
            magSwing = Math.max(magSwing, clip.quaternion.angleTo(bindQuat));
          }
          return viewmodel.reloading ? setTimeout(check, 50) : resolve();
        };
        setTimeout(check, 50);
      });
      const muzzleAfter = viewmodel.muzzlePosition();
      viewmodel.onNotetrack = originalNotetrack;
      api.weaponEffects.playFoley = originalFoley;
      return {
        started,
        mid,
        done: !viewmodel.reloading,
        magazine: api.weapon.magazine,
        reserveUsed: beforeReserve - api.weapon.reserveAmmo,
        muzzle: [muzzleAfter.x, muzzleAfter.y, muzzleAfter.z].map((n) => Number(n.toFixed(1))),
        cues,
        played,
        timelineCleared: viewmodel.activeTimeline === null,
        hasMagazine: Boolean(clip),
        magTravel: Number(magTravel.toFixed(2)),
        magReseated: clip && rest ? Number(clip.position.distanceTo(rest).toFixed(2)) : null,
        magSwingDeg: Number((magSwing * 180 / Math.PI).toFixed(1)),
        magEndAngleDeg: clip && bindQuat
          ? Number((clip.quaternion.angleTo(bindQuat) * 180 / Math.PI).toFixed(1))
          : null,
        magRestQuat: clip ? clip.quaternion.toArray().map((n) => Number(n.toFixed(3))) : null,
      };
    });
    assert.equal(reload.started, true, 'reload should start on demand');
    assert.equal(reload.mid, true, 'reload should be in progress');
    assert.equal(reload.done, true, 'reload should finish');
    assert.equal(reload.magazine, 30, 'reload should refill the magazine');
    assert.ok(reload.reserveUsed >= 2, 'reload should transfer rounds fired by API and mouse input');
    assert.ok(reload.muzzle[2] < 0, `muzzle still ahead after reload, got ${reload.muzzle}`);
    assert.ok(Math.abs(reload.muzzle[0]) < 12, `weapon still centered after reload, got ${reload.muzzle}`);

    const sounds = reload.cues.filter((cue) => cue.type === 'sound');
    assert.deepEqual(sounds.map((cue) => cue.name),
      ['fly_reload_cloth_sm', 'fly_hk416_mag_out', 'fly_hk416_futz', 'fly_hk416_mag_in'],
      `reload should fire its authored audio cues in order: ${JSON.stringify(reload.cues)}`);
    assert.ok(reload.cues.some((cue) => cue.type === 'rumble'),
      'rumble cues should be delivered alongside the sound cues');
    // Each cue must land at its authored time, within one frame of slack.
    const authored = { fly_reload_cloth_sm: 0.0333, fly_hk416_mag_out: 0.4667, fly_hk416_futz: 1.3, fly_hk416_mag_in: 1.4 };
    for (const cue of sounds) {
      assert.ok(Math.abs(cue.at - authored[cue.name]) < 0.09,
        `${cue.name} fired at ${cue.at}, authored ${authored[cue.name]}`);
    }
    assert.deepEqual(reload.played.map((p) => p.ok), Array(4).fill(true),
      `every reload cue should find a decoded buffer: ${JSON.stringify(reload.played)}`);
    assert.equal(reload.timelineCleared, true, 'the timeline should be released when the reload ends');
    assert.equal(reload.hasMagazine, true, 'the magazine attachment model should be mounted at tag_clip');
    // The clip's tag_clip position track is a constant source-scene placement,
    // so once rebased the magazine must stay seated for the whole reload
    // rather than being thrown 163 units out of the world by the raw track.
    assert.ok(reload.magTravel < 0.5,
      `the magazine should stay in the magwell, drifted ${reload.magTravel}`);
    assert.ok(reload.magReseated < 0.5,
      `the magazine should end seated, ended ${reload.magReseated} from rest`);
    // The clip's rotation channel is what actually takes the magazine out of
    // the well and puts it back, in step with the mag_out/mag_in cues.
    assert.ok(reload.magSwingDeg > 60,
      `the magazine should swing out of the well, peaked at ${reload.magSwingDeg} deg`);
    assert.ok(reload.magEndAngleDeg < 2,
      `the magazine should end reseated, ended ${reload.magEndAngleDeg} deg off bind`);
    // Regression: played raw, the track opens on identity and rolls the
    // magazine onto its side. It must come to rest on its bind orientation.
    assert.ok(Math.abs(reload.magRestQuat[0] + 0.7071) < 0.01
      && Math.abs(reload.magRestQuat[3] - 0.7071) < 0.01,
      `the magazine must rest upright, not flipped: ${JSON.stringify(reload.magRestQuat)}`);

    const hud = await page.locator('#hud').innerText();
    assert.match(hud, /nav shown/);
    assert.match(hud, /collision shown/);
    assert.match(hud, /ammo 30\/\d+/);
    assert.match(hud, /health \d+/);
    assert.match(hud, /enemies \d+\/6/);
    assert.match(hud, /(grounded|air)/);
    await page.screenshot({ path: path.join(os.tmpdir(), 'hijacked-smoke.png') });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
