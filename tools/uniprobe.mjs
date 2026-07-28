/**
 * Compares a material's compiled program's active uniform list against the
 * uniforms object it actually provides. three filters the upload list to the
 * intersection at compile time, so a mismatch here means the uniforms object
 * changed identity after the program was cached.
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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => { window.__UI_DEMO = true; });

page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('PROBE')) console.log(t);
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 }).catch(() => {});

// Name the material that actually throws, then dump its uniform bookkeeping.
await page.evaluate(() => {
  const r = window.__ENGINE.renderer;
  const orig = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
    try {
      return orig(cam, scene, geo, mat, obj, group);
    } catch (e) {
      if (!window.__reported) {
        window.__reported = true;
        const props = r.properties.get(mat);
        const prog = props && props.currentProgram;
        let active = [];
        try { active = prog.getUniforms().seq.map((u) => u.id); } catch (_) {}
        const provided = mat.uniforms ? Object.keys(mat.uniforms) : [];
        console.log('PROBE material :', mat?.name, '|', mat?.type, '| object:', obj?.name);
        console.log('PROBE active   :', active.join(','));
        console.log('PROBE provided :', provided.join(','));
        console.log('PROBE missing  :', active.filter((k) => !(k in (mat.uniforms || {}))).join(','));
        const list = props && props.uniformsList;
        console.log('PROBE cachedList:', list ? list.map((u) => u.id).join(',') : '(none)');
      }
      throw e;
    }
  };
});

await page.waitForTimeout(60000);
await browser.close();
await server.close();
