import { chromium } from 'playwright';
import { createServer } from 'vite';
const ROOT='/home/user/shochan';
const server = await createServer({ root: ROOT, logLevel:'error', server:{port:0,host:'127.0.0.1'} });
await server.listen();
const port = server.config.server.port || server.httpServer.address().port;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({ viewport:{width:800,height:450} });
p.setDefaultTimeout(300000);
await p.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY === true',null,{timeout:240000}).catch(()=>{});
const out = await p.evaluate(() => {
  const rows=[];
  window.__ENGINE.scene.traverse(o=>{
    if(!o.isMesh && !o.isPoints && !o.isSprite) return;
    o.geometry?.computeBoundingSphere?.();
    const r=o.geometry?.boundingSphere?.radius ?? 0;
    const m0=Array.isArray(o.material)?o.material[0]:o.material;
    if(r < 60 && !m0?.transparent) return;
    const m=m0;
    rows.push({name:o.name||o.type, r:Math.round(r), transparent:!!m?.transparent,
      opacity:m?.opacity, blending:m?.blending, depthWrite:m?.depthWrite,
      mat:m?.type, visible:o.visible, parent:o.parent?.name||''});
  });
  return rows.sort((a,b)=>b.r-a.r);
});
console.log(JSON.stringify(out,null,1));
await b.close(); await server.close();
