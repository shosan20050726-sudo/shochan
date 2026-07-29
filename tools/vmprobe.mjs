/**
 * Prints the viewmodel's own anchor points and bounding box in model space,
 * so hand placement can be derived from the geometry that actually exists
 * rather than guessed from the weapon definition's nominal dimensions.
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
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 }).catch(() => {});

const out = await page.evaluate(() => {
  const THREE = window.__THREE;
  const w = window.__ENGINE.get('weapons');
  const rows = [];
  for (const slot of (w?.slots || [])) {
    const vm = slot.vm;
    // Measure the gun only, with the arms hidden, or the arms inflate the box.
    const arms = vm.arms?.group;
    const wasVisible = arms ? arms.visible : null;
    if (arms) arms.visible = false;
    const box = new THREE.Box3().setFromObject(vm.root);
    if (arms) arms.visible = wasVisible;
    const f = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    rows.push({
      id: slot.def.id,
      muzzle: f(vm.muzzle), eject: f(vm.eject), sight: f(vm.sight),
      min: f(box.min), max: f(box.max),
      nodes: Object.keys(vm.nodes || {}).join('|'),
    });
  }
  return rows;
});

for (const r of out) {
  console.log(`VM ${r.id}`);
  console.log(`   muzzle ${r.muzzle}   eject ${r.eject}   sight ${r.sight}`);
  console.log(`   bbox   min ${r.min}   max ${r.max}`);
  console.log(`   nodes  ${r.nodes}`);
}

await browser.close();
await server.close();
