import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const webRoot = path.resolve(root, 'export', 'web');
const artifactRoot = path.resolve(root, process.env.AI_GAME_ARTIFACT_DIR ?? 'artifacts/ai-game');
const viewport = { width: 1280, height: 720 };
const command = process.argv[2] ?? 'help';
const commandArgument = process.argv[3];

const mimeTypes = new Map([
  ['.bin', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
]);

function usage() {
  return `AI game observer

Usage:
  npm run ai:game -- state
  npm run ai:game -- screenshot [camo]
  npm run ai:game -- test
  npm run ai:game -- enemy-test
  npm run ai:game -- life-test
  npm run ai:game -- record [seconds]

Environment:
  AI_GAME_HEADED=1             Show the controlled browser window
  AI_GAME_ARTIFACT_DIR=<path>  Override artifacts/ai-game
  BROWSER_PATH=<path>          Override Chrome or Edge executable
  BROWSER_TEST_URL=<url>       Use an already-running game server
`;
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function staticServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const relative = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      const filename = path.resolve(webRoot, `.${relative}`);
      if (filename !== webRoot && !filename.startsWith(`${webRoot}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const stat = await fs.promises.stat(filename);
      if (!stat.isFile()) throw new Error('Not a file');
      response.writeHead(200, {
        'Content-Type': mimeTypes.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filename).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function writeJson(filename, value) {
  await fs.promises.writeFile(
    path.join(artifactRoot, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function run() {
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (!['state', 'screenshot', 'test', 'enemy-test', 'life-test', 'record'].includes(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome or Edge was not found. Set BROWSER_PATH to its executable.');
  await fs.promises.mkdir(artifactRoot, { recursive: true });

  const ownedServer = process.env.BROWSER_TEST_URL ? null : await staticServer();
  const gameUrl = process.env.BROWSER_TEST_URL ?? ownedServer.url;
  const consoleMessages = [];
  const errors = [];
  const recordSeconds = Math.max(1, Math.min(60, Number(commandArgument) || 5));
  const videoDirectory = path.join(artifactRoot, 'video');
  if (command === 'record') await fs.promises.mkdir(videoDirectory, { recursive: true });

  let browser;
  let context;
  let page;
  let traceStarted = false;
  let video;
  let result;
  let failure;
  let inputProbe = null;

  try {
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: process.env.AI_GAME_HEADED !== '1',
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-angle=swiftshader',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    context = await browser.newContext({
      viewport,
      ...(command === 'record' ? { recordVideo: { dir: videoDirectory, size: viewport } } : {}),
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    page = await context.newPage();
    video = page.video();

    page.on('console', (message) => {
      const entry = `[console:${message.type()}] ${message.text()}`;
      consoleMessages.push(entry);
      if (message.type() === 'error') errors.push(entry);
    });
    page.on('pageerror', (error) => {
      const entry = `[pageerror] ${error.stack ?? error.message}`;
      consoleMessages.push(entry);
      errors.push(entry);
    });
    page.on('requestfailed', (request) => {
      const entry = `[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`;
      consoleMessages.push(entry);
      // Chrome reports in-flight streaming responses as aborted when the page
      // closes, even after the corresponding glTF has loaded successfully.
      if (!entry.includes('net::ERR_ABORTED')) errors.push(entry);
    });

    const response = await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok()) throw new Error(`Game returned HTTP ${response?.status() ?? 'unknown'}`);
    await page.waitForFunction(
      () => globalThis.hijacked?.debug?.getState().ready === true,
      null,
      { timeout: 180_000 },
    );

    await page.evaluate(() => {
      globalThis.hijacked.debug.setActive(true);
      globalThis.hijacked.debug.resume();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => globalThis.hijacked.debug.pause());
    const before = await page.evaluate(() => globalThis.hijacked.debug.getState());
    await writeJson('before-state.json', before);
    await page.screenshot({ path: path.join(artifactRoot, 'before.png') });

    if (command === 'screenshot' && commandArgument) {
      const camos = await page.evaluate(() => globalThis.hijacked.debug.getState().weapon.availableCamos);
      if (!camos.includes(commandArgument)) throw new Error(`Unknown weapon camo: ${commandArgument}`);
      await page.evaluate((name) => globalThis.hijacked.debug.setWeaponCamo(name), camos[0]);
      for (let i = 0; i < camos.length; i += 1) {
        const selected = await page.evaluate(() => globalThis.hijacked.debug.getState().weapon.camo);
        if (selected === commandArgument) break;
        await page.keyboard.press('k');
      }
      const selected = await page.evaluate(() => globalThis.hijacked.debug.getState().weapon.camo);
      if (selected !== commandArgument) throw new Error(`Could not select weapon camo: ${commandArgument}`);
      inputProbe = { camo: selected, input: 'keyboard' };
    } else if (command === 'test') {
      await page.evaluate(() => globalThis.hijacked.debug.resume());
      await page.keyboard.down('w');
      await page.waitForTimeout(900);
      await page.keyboard.up('w');
      await page.evaluate(() => {
        globalThis.__aiMouseProbe = [];
        for (const type of ['mousedown', 'mouseup']) {
          document.addEventListener(type, (event) => {
            globalThis.__aiMouseProbe.push({
              type,
              button: event.button,
              triggerHeld: globalThis.hijacked.weapon.triggerHeld,
              active: globalThis.hijacked.debug.getState().active,
              paused: globalThis.hijacked.debug.getState().paused,
            });
          });
        }
      });
      const canvas = await page.locator('canvas').boundingBox();
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      await page.mouse.down({ button: 'left' });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await page.mouse.up({ button: 'left' });
      inputProbe = await page.evaluate(() => globalThis.__aiMouseProbe);
      await page.evaluate(() => globalThis.hijacked.debug.pause());
    } else if (command === 'enemy-test') {
      const staged = await page.evaluate(() => {
        const api = globalThis.hijacked;
        const feet = api.player.feetPosition;
        const offsets = [
          [-500, -180], [-570, -105], [-520, -35],
          [-590, 40], [-510, 115], [-600, 185],
        ];
        const positions = offsets.map(([x, z], index) =>
          api.debug.teleportEnemy(index, [feet.x + x, feet.y, feet.z + z]));
        const first = api.enemies.enemies[0].eyePosition();
        api.debug.lookAt([first.x, first.y - 12, first.z]);
        const alerted = api.debug.alertEnemies(2000);
        api.debug.resume();
        return { positions, alerted };
      });
      await page.waitForTimeout(4500);
      await page.evaluate(() => globalThis.hijacked.debug.pause());
      inputProbe = { staged };
    } else if (command === 'life-test') {
      inputProbe = await page.evaluate(() => {
        const before = globalThis.hijacked.debug.getState();
        globalThis.hijacked.debug.setWeaponAmmo(3, 4);
        globalThis.hijacked.debug.resume();
        globalThis.hijacked.debug.damagePlayer(1000);
        return { before };
      });
      await page.waitForTimeout(250);
      inputProbe.dead = await page.evaluate(() => globalThis.hijacked.debug.getState());
      await page.screenshot({ path: path.join(artifactRoot, 'death.png') });
      // Headless SwiftShader can deliver far fewer animation frames than wall
      // time while screenshots are being encoded, so wait on game state.
      await page.waitForFunction(
        () => globalThis.hijacked.debug.getState().player.dead === false,
        null,
        { timeout: 20_000 },
      );
      await page.evaluate(() => globalThis.hijacked.debug.pause());
    } else if (command === 'record') {
      await page.evaluate(() => globalThis.hijacked.debug.resume());
      await page.keyboard.down('w');
      await page.waitForTimeout(recordSeconds * 1000);
      await page.keyboard.up('w');
      await page.evaluate(() => globalThis.hijacked.debug.pause());
    }

    const state = await page.evaluate(() => globalThis.hijacked.debug.getState());
    await writeJson('state.json', state);
    await page.screenshot({ path: path.join(artifactRoot, 'screenshot.png') });

    const checks = command === 'test' ? {
      ready: state.ready === true,
      playerMoved: distance(before.player.feet, state.player.feet) > 10,
      weaponFired: state.weapon.fireCount > before.weapon.fireCount,
      ammoDecreased: state.weapon.magazine < before.weapon.magazine,
      sixEnemiesLoaded: state.enemies.length === 6,
      noBrowserErrors: errors.length === 0,
    } : command === 'enemy-test' ? {
      ready: state.ready === true,
      sixEnemiesStaged: inputProbe.staged.positions.every(Boolean),
      squadAlerted: inputProbe.staged.alerted === 6,
      tacticalStatesActive: state.enemies.some((enemy) =>
        ['attack', 'reposition', 'chase', 'search'].includes(enemy.state)),
      artificialFiringLimitRemoved: state.enemies
        .filter((enemy) => enemy.shotsFired > 0).length >= 3,
      playerSurvivedEncounter: state.player.dead === false,
      squadUsesMultipleTargets: new Set(state.enemies
        .map((enemy) => JSON.stringify(enemy.combatTarget))
        .filter((target) => target !== 'null')).size > 1,
      noBrowserErrors: errors.length === 0,
    } : command === 'life-test' ? {
      deathStateVisible: inputProbe.dead.player.dead === true && inputProbe.dead.player.respawnSeconds > 0,
      deathRecorded: state.match.standings.find((entry) => entry.id === 'player')?.deaths === 1,
      playerRespawned: state.player.dead === false && state.player.health === state.player.maxHealth,
      loadoutRestored: state.weapon.magazine === state.weapon.magazineSize && state.weapon.reserveAmmo === 240,
      safeSpawnChanged: distance(inputProbe.before.player.feet, state.player.feet) > 100,
      noBrowserErrors: errors.length === 0,
    } : {
      ready: state.ready === true,
      playerAvailable: Boolean(state.player),
      sixEnemiesLoaded: state.enemies.length === 6,
      noBrowserErrors: errors.length === 0,
    };
    result = {
      command,
      passed: Object.values(checks).every(Boolean),
      checks,
      errors,
      ...(inputProbe ? { inputProbe } : {}),
      artifacts: artifactRoot,
      ...(command === 'record' ? { seconds: recordSeconds } : {}),
    };
    await writeJson('report.json', result);
  } catch (error) {
    failure = error;
    errors.push(`[harness] ${error.stack ?? error.message}`);
    result = { command, passed: false, errors, artifacts: artifactRoot };
    await writeJson('report.json', result);
  } finally {
    await fs.promises.writeFile(
      path.join(artifactRoot, 'console.log'),
      `${consoleMessages.join('\n')}${consoleMessages.length ? '\n' : ''}`,
      'utf8',
    );
    if (traceStarted) {
      try {
        await context.tracing.stop({ path: path.join(artifactRoot, 'trace.zip') });
      } catch (error) {
        errors.push(`[trace] ${error.message}`);
      }
    }
    if (page && !page.isClosed()) await page.close();
    if (command === 'record' && video) {
      try {
        const recordedPath = await video.path();
        await fs.promises.copyFile(recordedPath, path.join(artifactRoot, 'recording.webm'));
      } catch (error) {
        errors.push(`[video] ${error.message}`);
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await ownedServer?.close().catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failure || !result?.passed) process.exitCode = 1;
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
