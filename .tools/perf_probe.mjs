import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const webRoot = path.join(root, 'export', 'web');
const output = path.join(root, 'artifacts', 'perf-after.json');
const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!browserPath) throw new Error('Chrome or Edge was not found.');

const mime = new Map([
  ['.bin', 'application/octet-stream'], ['.glb', 'model/gltf-binary'],
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'], ['.png', 'image/png'], ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
]);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = path.resolve(webRoot, `.${relative}`);
    if (!filename.startsWith(`${webRoot}${path.sep}`)) throw new Error('Forbidden');
    const stat = await fs.promises.stat(filename);
    response.writeHead(200, {
      'Content-Type': mime.get(path.extname(filename)) ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filename).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let browser;
let context;
try {
  const startedAt = performance.now();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-background-timer-throttling'],
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const failures = [];
  const browserCancelledRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`[console] ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`[page] ${error.message}`));
  page.on('requestfailed', (request) => {
    const entry = `[request] ${request.url()} ${request.failure()?.errorText ?? ''}`;
    // Chromium can cancel a redundant streaming request after GLTFLoader has
    // already resolved the asset; the project's AI harness classifies the same
    // ERR_ABORTED event separately from an actual failed asset response.
    if (entry.includes('net::ERR_ABORTED')) browserCancelledRequests.push(entry);
    else failures.push(entry);
  });
  await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const domContentLoadedMilliseconds = performance.now() - startedAt;
  await page.waitForFunction(
    () => globalThis.hijacked?.debug?.getState().ready === true,
    null,
    { timeout: 180_000 },
  );
  const readyMilliseconds = performance.now() - startedAt;

  async function sample(label, setup) {
    if (setup) await page.evaluate(setup);
    const result = await page.evaluate(async () => {
      const intervals = [];
      let previous = performance.now();
      const begin = previous;
      await new Promise((resolve) => {
        function frame(now) {
          intervals.push(now - previous);
          previous = now;
          if (now - begin >= 5000) resolve();
          else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      intervals.sort((a, b) => a - b);
      const pick = (fraction) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * fraction))];
      return {
        frames: intervals.length,
        averageMilliseconds: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
        p50Milliseconds: pick(0.5),
        p95Milliseconds: pick(0.95),
        maximumMilliseconds: intervals.at(-1),
        renderer: globalThis.hijacked.debug.getState().performance,
      };
    });
    return { label, ...result };
  }

  const idle = await sample('idle', () => {
    globalThis.hijacked.debug.setActive(true);
    globalThis.hijacked.debug.resume();
  });
  const encounter = await sample('six-enemy encounter', () => {
    const api = globalThis.hijacked;
    const feet = api.player.feetPosition;
    const offsets = [[-500, -180], [-570, -105], [-520, -35], [-590, 40], [-510, 115], [-600, 185]];
    offsets.forEach(([x, z], index) => api.debug.teleportEnemy(index, [feet.x + x, feet.y, feet.z + z]));
    api.debug.alertEnemies(2000);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const details = await page.evaluate(() => {
    let sceneObjects = 0;
    globalThis.hijacked.scene.traverse(() => { sceneObjects += 1; });
    const resources = performance.getEntriesByType('resource');
    return {
      sceneObjects,
      heapAfterGcMegabytes: performance.memory?.usedJSHeapSize / 1048576 ?? null,
      resources: {
        requests: resources.length,
        transferredMegabytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0) / 1048576,
        decodedMegabytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0) / 1048576,
      },
    };
  });
  const result = {
    domContentLoadedMilliseconds,
    readyMilliseconds,
    idle,
    encounter,
    details,
    browserCancelledRequests,
    failures,
  };
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await fs.promises.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
