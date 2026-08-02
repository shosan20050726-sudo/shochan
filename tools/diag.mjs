/**
 * A/B diagnostic renderer. Boots the game once, then captures the same camera
 * pose under several in-page mutations so a visual artifact can be isolated by
 * elimination rather than guessed at.
 *
 *   node tools/diag.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = resolve(ROOT, 'shots', 'diag');
const POSE = { pos: [118, 66, 128], look: [10, 6, -40], fov: 68 };

/** Each variant mutates the live scene, then we shoot the identical pose. */
const VARIANTS = [
  ['a-baseline', () => {}],
  ['p-skyfirst', () => {
    // The dome is drawn after opaques and relies on depth rejection to stay
    // behind them. Draw it first with depth testing off instead, which is the
    // classic skybox order and cannot cover geometry regardless of how its
    // depth ends up.
    window.__ENGINE.scene.traverse((o) => {
      if (String(o.name).toLowerCase().includes('skydome')) {
        o.renderOrder = -10000;
        o.material.depthTest = false;
        o.material.depthWrite = false;
        o.material.needsUpdate = true;
      }
    });
  }],
  ['o-nosky', () => {
    // The wedge survives bypassing post, so it is in the raw scene render.
    // The sky dome is the one thing in that render never yet removed on its
    // own. If the wedge goes with it, the dome shader is the culprit.
    window.__ENGINE.scene.traverse((o) => {
      if (o.material && o.material.name === 'gfx.sky') o.visible = false;
      if (String(o.name).toLowerCase().includes('sky')) o.visible = false;
    });
  }],
  ['n-aoblack', () => {
    // Force the AO tint to pure black and crank the term. If creases go black,
    // the AO buffer has content and the effect was merely too subtle to see.
    // If the frame is unchanged, SSAO is returning "unoccluded" everywhere and
    // the fault is upstream of the composite.
    const pf = window.__ENGINE.get('postfx');
    pf.aerialPass.material.uniforms.uAOColor.value.set(0, 0, 0);
    const u = pf.ssaoMat?.uniforms;
    if (u) { u.uIntensity.value = 4; u.uRadius.value = 1.2; u.uPower.value = 1.0; }
  }],
  ['m-noring', () => {
    // The ring wall only exists once a match stage fires. Hiding it separates
    // "the atmosphere is washed out" from "a translucent wall fills the view".
    window.__ENGINE.scene.traverse((o) => {
      if (String(o.name).includes('ringwall')) o.visible = false;
    });
  }],
  ['b-noshadow', () => {
    // Kill every shadow-casting light, CSM cascades included.
    window.__ENGINE.scene.traverse((o) => { if (o.isLight) o.castShadow = false; });
    const csm = window.__ENGINE.get('postfx')?.lighting?.csm
             ?? window.__ENGINE.get('lighting')?.csm;
    csm?.lights?.forEach((l) => { l.castShadow = false; });
  }],
  ['k-nopost', () => {
    // Engine falls back to a plain forward render when postfx exposes no
    // render(); this isolates the post chain from the scene itself.
    const pf = window.__ENGINE.get('postfx');
    if (pf) pf.render = undefined;
  }],
  ['j-shadowmapoff', () => {
    // castShadow=false leaves the CSM shader branch compiled in and still
    // sampling; this actually recompiles the materials without shadow code.
    const e = window.__ENGINE;
    e.renderer.shadowMap.enabled = false;
    e.scene.traverse((o) => {
      const m = o.material; if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
    });
  }],
  ['h-nomotes', () => {
    window.__ENGINE.scene.traverse((o) => { if (o.name === 'vfx:motes') o.visible = false; });
  }],
  ['i-noparticles', () => {
    window.__ENGINE.scene.traverse((o) => {
      if (o.name === 'vfx:motes' || String(o.name).startsWith('vfx:')) o.visible = false;
    });
  }],
  ['l-ssaomax', () => {
    // Crank AO far past any sane value. If the frame is unchanged, the AO
    // buffer is not reaching the composite and this is plumbing, not tuning.
    const pf = window.__ENGINE.get('postfx');
    const u = pf?.ssaoMat?.uniforms;
    if (u) { u.uIntensity.value = 8; u.uRadius.value = 3.0; u.uPower.value = 1.0; }
    window.__PROBE_SSAO = !!u;
  }],
  ['c-noenv', () => { window.__ENGINE.scene.environment = null; }],
  ['d-nofog', () => { window.__ENGINE.scene.fog = null; }],
  ['e-normals', () => {
    // Visualise the terrain's shading normals. If the bands survive here, they
    // are geometric, not a shader/lighting problem.
    const THREE = window.__THREE;
    window.__ENGINE.scene.traverse((o) => {
      if (o.name === 'terrain') o.material = new THREE.MeshNormalMaterial();
    });
  }],
  ['g-white', () => {
    // Lit, but untextured: separates real landform shading from the splat.
    const THREE = window.__THREE;
    window.__ENGINE.scene.traverse((o) => {
      if (o.name === 'terrain') o.material = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 1 });
    });
  }],
  ['f-flat', () => {
    const THREE = window.__THREE;
    window.__ENGINE.scene.traverse((o) => {
      if (o.name === 'terrain') o.material = new THREE.MeshBasicMaterial({ color: 0x888888 });
    });
  }],
];

async function waitFrames(page, n = 5) {
  const s = await page.evaluate(() => window.__ENGINE?.clock?.frame ?? 0).catch(() => 0);
  await page.waitForFunction(([a, k]) => (window.__ENGINE?.clock?.frame ?? 0) >= a + k,
    [s, n], { timeout: 300000, polling: 250 }).catch(() => {});
}

const server = await createServer({
  root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' },
});
await server.listen();
const port = server.config.server.port || server.httpServer.address().port;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);

mkdirSync(OUT, { recursive: true });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 }).catch(() => {});
await waitFrames(page, 4);

// Hide the HUD so it cannot mask the region under inspection.
await page.evaluate(() => {
  const r = document.getElementById('ui-root'); if (r) r.style.display = 'none';
});

const only = process.argv[2];
for (const [name, mutate] of VARIANTS.filter(v => !only || v[0].includes(only))) {
  await page.evaluate((p) => {
    const e = window.__ENGINE;
    const pl = e.get('player'); if (pl) pl.enabled = false;
    e.camera.position.set(...p.pos);
    e.camera.lookAt(...p.look);
    e.camera.fov = p.fov; e.camera.updateProjectionMatrix();
  }, POSE);
  await page.evaluate(mutate).catch((e) => console.log(name, 'mutate failed:', e.message));
  await waitFrames(page, 5);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), timeout: 300000 });
  console.log('shot', name);
}

await browser.close();
await server.close();
console.log('OUT:', OUT);
