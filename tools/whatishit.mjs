/**
 * Names whatever fills a given screen region at a given camera pose.
 * Raycasts through several NDC points and reports the object and material hit,
 * so a "the sky is wrong" report becomes a specific mesh.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = '/home/user/shochan';
const POSE = { pos: [118, 66, 128], look: [10, 6, -40], fov: 68 };  // 01-vista

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

const out = await page.evaluate((p) => {
  const THREE = window.__THREE;
  const e = window.__ENGINE;
  const pl = e.get('player'); if (pl) pl.enabled = false;
  e.camera.position.set(...p.pos);
  e.camera.lookAt(...p.look);
  e.camera.fov = p.fov;
  e.camera.updateProjectionMatrix();
  e.camera.updateMatrixWorld(true);

  const rc = new THREE.Raycaster();
  const rows = [];
  // Sample the upper half of the frame, where the wood appears.
  const pts = [[0.75, 0.75], [0.9, 0.5], [-0.85, -0.6], [-0.5, -0.8], [0.3, 0.2], [-0.2, 0.5]];
  for (const [x, y] of pts) {
    rc.setFromCamera(new THREE.Vector2(x, y), e.camera);
    rc.far = 5000;
    const hits = rc.intersectObjects(e.scene.children, true);
    const vis = hits.filter((k) => k.object.visible && k.object.type === 'Mesh');
    const h = vis[0];
    const stack = vis.slice(0, 3).map((k) => `${k.object.name}@${Math.round(k.distance)}`).join(' > ');
    rows.push({
      ndc: `${x},${y}`,
      obj: h ? (h.object.name || h.object.type) : '(sky/nothing)',
      dist: h ? Math.round(h.distance) : -1,
      mat: h ? (Array.isArray(h.object.material) ? 'multi' : (h.object.material?.name || h.object.material?.type)) : '',
      surface: h ? (h.object.userData?.surface || '') : '',
      stack,
    });
  }
  return rows;
}, POSE);

for (const r of out) {
  console.log(`HIT ndc=${r.ndc.padEnd(9)} dist=${String(r.dist).padStart(5)} obj=${r.obj} mat=${r.mat} surface=${r.surface} stack=${r.stack}`);
}

await browser.close();
await server.close();
