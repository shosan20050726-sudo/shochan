/**
 * Asks the runtime three questions about ambient occlusion that reading the
 * source cannot answer:
 *
 *   1. Does the AO render target actually contain occlusion, or is it white?
 *   2. Is the uniform still bound to that exact texture object at draw time?
 *   3. Did the shader that consumes it compile with USE_AO defined?
 *
 * Reading the code says all three are fine. Writing arbitrary content into the
 * AO buffer and seeing no change in the frame says otherwise, so one of these
 * is lying.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = '/home/user/shochan';
const server = await createServer({
  root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' },
});
await server.listen();
const port = server.config.server.port || server.httpServer.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 }).catch(() => {});

// Point the camera at a wall/ground junction, where AO should be strongest.
await page.evaluate(() => {
  const e = window.__ENGINE;
  const pl = e.get('player'); if (pl) pl.enabled = false;
  e.camera.position.set(-56, 1.7, -116);
  e.camera.lookAt(-56, 1.5, -148);
  e.camera.updateProjectionMatrix();
});
await page.waitForTimeout(20000);

const out = await page.evaluate(() => {
  const e = window.__ENGINE;
  const pf = e.get('postfx');
  const r = e.renderer;
  const res = {};

  res.useSSAO = pf.useSSAO;
  res.aoBoundToRT = pf.aerialPass.material.uniforms.tAO.value === pf.rtAO.texture;
  res.aoUniformIsNull = pf.aerialPass.material.uniforms.tAO.value == null;
  res.defines = Object.keys(pf.aerialPass.material.defines || {}).join(',');

  // What the compiled program actually has, not what the defines object says.
  const props = r.properties.get(pf.aerialPass.material);
  const prog = props && props.currentProgram;
  res.programExists = !!prog;
  try {
    res.programUniforms = prog.getUniforms().seq.map((u) => u.id).join(',');
  } catch (_) { res.programUniforms = '(unavailable)'; }

  // Read the AO target back. If SSAO is producing occlusion, this is not all 255.
  const w = pf.rtAO.width, h = pf.rtAO.height;
  const buf = new Uint8Array(4 * 64);
  try {
    r.readRenderTargetPixels(pf.rtAO, Math.floor(w / 2) - 4, Math.floor(h / 2) - 4, 8, 8, buf);
    let min = 255, max = 0, sum = 0;
    for (let i = 0; i < 64; i++) {
      const v = buf[i * 4];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    res.aoPixels = { min, max, mean: Math.round(sum / 64) };
  } catch (err) { res.aoPixels = 'readback failed: ' + err.message; }

  res.aoSize = `${w}x${h}`;
  return res;
});

for (const [k, v] of Object.entries(out)) {
  console.log(`AO ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

await browser.close();
await server.close();
