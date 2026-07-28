/**
 * The entire HUD stylesheet, injected once into #ui-root.
 *
 * Design language: angular (clip-path corner cuts, -11deg skew), hairline
 * strokes, almost no filled panels — legibility comes from hard drop shadows
 * so the HUD sits over bright desert or dark interiors equally well.
 * Everything that changes is a CSS custom property so transitions do the
 * easing rather than JS.
 */
export const CSS = /* css */`
.hud, .hud * { box-sizing: border-box; }
.hud {
  position: absolute; inset: 0; overflow: hidden;
  color: var(--tx); pointer-events: none; user-select: none;
  font-family: inherit; font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "ss01" 1;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;

  --tx: #eef7ff; --dim: #c2d6e6; --dim2: #93aec4;
  --edge: rgba(150,200,235,0.30); --edge2: rgba(150,200,235,0.13);
  --acc: #ff8a2a; --acc2: #ffcf5c; --cy: #6fdcff;
  --hp: #5ce08d; --hpHi: #d9ffe8; --bad: #ff5a68;
  --sh: #a45cff; --shHi: #e2ccff;
  --shadow: 0 1px 1px rgba(0,0,0,.95), 0 2px 4px rgba(0,0,0,.8), 0 0 14px rgba(0,0,0,.55);
  --ez: cubic-bezier(.16,1,.3,1);
}
/* Corner scrims: one composited layer that guarantees HUD legibility over a
   blown-out desert sky without dimming the centre of the screen. */
.hud-scrim {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse farthest-side at 0% 100%, rgba(2,5,9,.80), rgba(2,5,9,0)) left bottom / 760px 340px no-repeat,
    radial-gradient(ellipse farthest-side at 100% 100%, rgba(2,5,9,.76), rgba(2,5,9,0)) right bottom / 660px 320px no-repeat,
    radial-gradient(ellipse farthest-side at 100% 0%, rgba(2,5,9,.72), rgba(2,5,9,0)) right top / 660px 360px no-repeat,
    radial-gradient(ellipse farthest-side at 0% 0%, rgba(2,5,9,.80), rgba(2,5,9,0)) left top / 600px 440px no-repeat,
    linear-gradient(180deg, rgba(2,5,9,.34), rgba(2,5,9,0) 9%),
    linear-gradient(0deg, rgba(2,5,9,.30), rgba(2,5,9,0) 8%);
}
.hud .lbl {
  font-size: 9.5px; font-weight: 700; letter-spacing: .26em; text-transform: uppercase;
  color: var(--dim2); text-shadow: var(--shadow);
}
.hud .num { font-weight: 700; letter-spacing: .01em; text-shadow: var(--shadow); }
.hud .sk { transform: skewX(-11deg); }
.hud .sk > * { transform: skewX(11deg); }

/* Corner bracket decoration used on framed groups. */
.hud .bkt::before, .hud .bkt::after {
  content: ''; position: absolute; width: 9px; height: 9px; pointer-events: none;
  border: 1.5px solid var(--edge);
}
.hud .bkt::before { left: -1px; top: -1px; border-right: 0; border-bottom: 0; }
.hud .bkt::after { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }

/* ------------------------------------------------------------ entrance -- */
@keyframes hud-in { from { opacity: 0; transform: translate3d(0, 10px, 0); } to { opacity: 1; transform: none; } }
@keyframes hud-in-l { from { opacity: 0; transform: translate3d(-18px, 0, 0); } to { opacity: 1; transform: none; } }
@keyframes hud-in-r { from { opacity: 0; transform: translate3d(18px, 0, 0); } to { opacity: 1; transform: none; } }
.hud .anim-in { animation: hud-in .6s var(--ez) both; }
.hud .anim-l { animation: hud-in-l .7s var(--ez) both; }
.hud .anim-r { animation: hud-in-r .7s var(--ez) both; }

/* =========================================================== crosshair == */
.hud-center { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.hud-xhair { position: absolute; left: 0; top: 0; width: 0; height: 0;
  --gap: 9px; --len: 7px; --thk: 2px; --xc: #eafaff; opacity: .96; }
.hud-xhair i {
  position: absolute; background: var(--xc); display: block;
  box-shadow: 0 0 0 1.1px rgba(0,0,0,.92), 0 0 7px rgba(0,0,0,.7);
  transition: transform .09s ease-out, opacity .12s linear, background .12s linear;
}
.hud-xhair .xt, .hud-xhair .xb { width: var(--thk); height: var(--len); left: calc(var(--thk) / -2); }
.hud-xhair .xl, .hud-xhair .xr { height: var(--thk); width: var(--len); top: calc(var(--thk) / -2); }
.hud-xhair .xt { top: calc(var(--gap) * -1 - var(--len)); }
.hud-xhair .xb { top: var(--gap); }
.hud-xhair .xl { left: calc(var(--gap) * -1 - var(--len)); }
.hud-xhair .xr { left: var(--gap); }
.hud-xhair .xdot { width: 2px; height: 2px; left: -1px; top: -1px; border-radius: 50%; opacity: var(--dotop, .85); }
.hud-xhair.ads .xdot { opacity: 1; }

/* ADS ring */
.hud-adsring { position: absolute; left: -26px; top: -26px; width: 52px; height: 52px;
  border: 1px solid rgba(230,250,255,.30); border-radius: 50%; opacity: 0; transform: scale(1.35);
  transition: opacity .16s ease, transform .22s var(--ez); }
.hud-xhair.ads .hud-adsring { opacity: 1; transform: scale(1); }

/* hit markers */
.hud-hit { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.hud-hit svg { position: absolute; left: -34px; top: -34px; width: 68px; height: 68px; opacity: 0; }
@keyframes hm-pop { 0% { opacity: 0; transform: scale(.45) rotate(0deg); } 12% { opacity: 1; transform: scale(1.06); }
  40% { opacity: .95; transform: scale(1); } 100% { opacity: 0; transform: scale(1.16); } }
.hud-hit svg.go { animation: hm-pop .48s var(--ez) forwards; }
@keyframes hm-kill { 0% { opacity: 0; transform: scale(.4) rotate(-14deg); } 10% { opacity: 1; transform: scale(1.14) rotate(0deg); }
  55% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.3); } }
.hud-hit svg.go-kill { animation: hm-kill .52s var(--ez) forwards; }
@keyframes ringburst { 0% { opacity: .9; transform: scale(.25); } 100% { opacity: 0; transform: scale(1.5); } }
.hud-hit .burst { animation: ringburst .5s ease-out forwards; }

/* damage direction arcs */
.hud-dmgdir { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.hud-dmgdir svg { position: absolute; left: -130px; top: -130px; width: 260px; height: 260px; opacity: 0; }
@keyframes ddir { 0% { opacity: 0; transform: scale(.82); } 14% { opacity: 1; transform: scale(1.02); }
  45% { opacity: .85; transform: scale(1); } 100% { opacity: 0; transform: scale(1.08); } }
.hud-dmgdir svg.go { animation: ddir 1.5s var(--ez) forwards; }

/* ============================================================== vitals == */
.hud-vitals { position: absolute; left: 30px; bottom: 30px; width: 372px; height: 96px; }
.hud-vitals .badge {
  position: absolute; left: 0; bottom: 4px; width: 52px; height: 58px; color: var(--cy);
  clip-path: polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%);
  background: linear-gradient(160deg, rgba(30,52,70,.92), rgba(10,18,26,.88));
  display: grid; place-items: center;
}
.hud-vitals .badge svg { width: 26px; height: 26px; opacity: .95; }
.hud-vitals .badge .lv {
  position: absolute; bottom: 5px; font-size: 9px; font-weight: 800; letter-spacing: .12em; color: var(--acc2);
}
.hud-vitals .badge-ring {
  position: absolute; left: -3px; bottom: 1px; width: 58px; height: 64px;
  clip-path: polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%);
  background: linear-gradient(160deg, rgba(120,190,235,.55), rgba(90,140,180,.12));
  z-index: -1;
}
.hud-vitals .bars { position: absolute; left: 66px; right: 0; bottom: 4px; }
.hud-vitals .rowlbl { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 5px; }
.hud-vitals .rowlbl .who { font-size: 11px; font-weight: 700; letter-spacing: .2em; color: var(--tx); text-shadow: var(--shadow); }
.hud-vitals .rowlbl .tier { font-size: 9px; font-weight: 700; letter-spacing: .22em; color: var(--sh); text-shadow: var(--shadow); }

.hud-bar {
  position: relative; height: var(--h, 15px); margin-bottom: 6px;
  transform: skewX(-11deg); transform-origin: left bottom;
  background: linear-gradient(180deg, rgba(6,11,16,.78), rgba(4,8,12,.86));
  box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 3px 12px rgba(0,0,0,.6);
  transition: width .45s var(--ez);
}
.hud-bar > * { position: absolute; left: 0; top: 0; bottom: 0; }
.hud-bar .ghost {
  background: var(--gcol, rgba(255,255,255,.55)); opacity: .5;
  transition: width .55s cubic-bezier(.3,0,.15,1) .28s;
}
.hud-bar .fill {
  background: linear-gradient(180deg, var(--c2) 0%, var(--c1) 46%, var(--c3) 100%);
  box-shadow: 0 0 10px -1px var(--glow, transparent);
  transition: width .16s cubic-bezier(.2,.85,.25,1), background .3s linear;
}
.hud-bar .fill::after {
  content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 2px;
  background: #fff; opacity: .75;
}
.hud-bar .notch { right: 0; background-image: var(--notches); pointer-events: none; }
.hud-bar .edge { right: 0; border: 1px solid var(--brd, rgba(150,200,235,.30)); }
.hud-bar .flash { right: 0; background: #fff; opacity: 0; }
@keyframes bar-flash { 0% { opacity: .6; } 100% { opacity: 0; } }
.hud-bar .flash.go { animation: bar-flash .26s ease-out forwards; }
.hud-bar.low .fill { animation: lowpulse 1s ease-in-out infinite alternate; }
@keyframes lowpulse { from { filter: brightness(1); } to { filter: brightness(1.55); } }

.hud-vitals .vals { position: absolute; right: 0; bottom: 5px; text-align: right; }
.hud-vitals .vals .v { font-size: 19px; font-weight: 700; line-height: 1.05; text-shadow: var(--shadow); font-style: italic; }
.hud-vitals .vals .vs { color: var(--sh); }
.hud-vitals .vals .vh { color: var(--hpHi); }
.hud-vitals .vals .vh.hurt { color: var(--bad); }

/* ============================================================== squad === */
.hud-squad { position: absolute; left: 30px; bottom: 138px; width: 250px; }
.hud-squad .hd { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; opacity: .9; }
.hud-squad .hd svg { width: 12px; height: 12px; color: var(--cy); }
.hud-mate {
  position: relative; display: flex; align-items: center; gap: 8px; height: 26px; margin-bottom: 5px;
  padding-left: 8px; transition: opacity .3s linear;
}
.hud-mate::before {
  content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px;
  background: var(--mc); transform: skewX(-11deg); box-shadow: 0 0 8px -1px var(--mc);
}
.hud-mate .nm { font-size: 11px; font-weight: 600; letter-spacing: .1em; width: 88px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-shadow: var(--shadow); }
.hud-mate .mbars { flex: 1; }
.hud-mate .mb { position: relative; height: 4px; background: rgba(6,11,16,.8); transform: skewX(-11deg); margin-bottom: 3px; }
.hud-mate .mb i { position: absolute; left: 0; top: 0; bottom: 0; display: block;
  transition: width .35s var(--ez); }
.hud-mate .st { font-size: 8.5px; font-weight: 800; letter-spacing: .16em; width: 40px; text-align: right; color: var(--dim2); }
.hud-mate.downed { opacity: 1; }
.hud-mate.downed .st { color: var(--bad); animation: blink 1.1s steps(1) infinite; }
.hud-mate.downed .nm { color: var(--bad); }
.hud-mate.dead { opacity: .38; }
.hud-mate.dead .nm { text-decoration: line-through; }
@keyframes blink { 0%,60% { opacity: 1; } 61%,100% { opacity: .25; } }

/* ============================================================= weapon === */
.hud-weapon { position: absolute; right: 30px; bottom: 28px; width: 350px; text-align: right; }
.hud-weapon .wname { font-size: 15px; font-weight: 700; letter-spacing: .26em; text-shadow: var(--shadow); }
.hud-weapon .wrow { display: flex; align-items: center; justify-content: flex-end; gap: 9px; margin-bottom: 4px; }
.hud-weapon .chip {
  font-size: 9px; font-weight: 800; letter-spacing: .18em; padding: 2px 7px 2px 8px;
  border: 1px solid currentColor; color: var(--cy); transform: skewX(-11deg);
  background: rgba(4,9,14,.42);
}
.hud-weapon .chip b { display: block; transform: skewX(11deg); }
.hud-weapon .wicon { color: var(--tx); opacity: .92; filter: drop-shadow(0 2px 5px rgba(0,0,0,.9)); }
.hud-weapon .wicon svg { width: 96px; height: 40px; fill: currentColor; }
.hud-weapon .ammo {
  display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; margin-top: -2px;
  font-style: italic; line-height: .95;
}
.hud-weapon .mag { font-size: 54px; font-weight: 800; letter-spacing: -.02em;
  text-shadow: 0 3px 14px rgba(0,0,0,.9); transition: color .18s linear; }
.hud-weapon .sep { font-size: 24px; font-weight: 400; color: var(--dim2); }
.hud-weapon .res { font-size: 24px; font-weight: 700; color: var(--dim); }
.hud-weapon.low .mag { color: var(--acc); }
.hud-weapon.empty .mag { color: var(--bad); animation: lowpulse .5s ease-in-out infinite alternate; }

.hud-weapon .strip { display: flex; justify-content: flex-end; gap: 2px; height: 7px; margin-top: 5px; }
.hud-weapon .strip i {
  display: block; width: 5px; background: var(--acc2); transform: skewX(-11deg);
  opacity: .95; transition: opacity .16s linear, background .16s linear;
  box-shadow: 0 0 6px -2px var(--acc2);
}
.hud-weapon .strip i.off { opacity: .16; background: #7e93a6; box-shadow: none; }

.hud-weapon .rwrap { position: relative; }
.hud-weapon .rload { position: relative; height: 3px; margin-top: 8px; background: rgba(255,255,255,.09);
  transform: skewX(-11deg); opacity: 0; transition: opacity .18s linear; }
.hud-weapon .rload i { position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(90deg, var(--acc), var(--acc2)); box-shadow: 0 0 10px -1px var(--acc2); }
.hud-weapon.reloading .rload { opacity: 1; }
.hud-weapon .rtxt { position: absolute; right: 0; top: -16px; font-size: 9.5px; font-weight: 800;
  letter-spacing: .3em; color: var(--acc2); opacity: 0; transition: opacity .18s linear; }
.hud-weapon.reloading .rtxt { opacity: 1; animation: blink .7s steps(1) infinite; }

.hud-weapon .slots { display: flex; justify-content: flex-end; gap: 6px; margin-top: 9px; }
.hud-weapon .slot {
  display: flex; align-items: center; gap: 6px; padding: 3px 8px; transform: skewX(-11deg);
  border: 1px solid var(--edge2); opacity: .45; transition: opacity .25s linear, border-color .25s linear;
}
.hud-weapon .slot > * { transform: skewX(11deg); }
.hud-weapon .slot.on { opacity: 1; border-color: var(--edge); background: linear-gradient(90deg, rgba(255,122,24,0), rgba(255,122,24,.16)); }
.hud-weapon .slot .k { font-size: 8.5px; font-weight: 800; color: var(--acc2); letter-spacing: .1em; }
.hud-weapon .slot .n { font-size: 9.5px; font-weight: 700; letter-spacing: .16em; color: var(--dim); }
.hud-weapon .slot.on .n { color: var(--tx); }

/* ========================================================== abilities === */
.hud-abil { position: absolute; left: 428px; bottom: 44px; display: flex; gap: 18px; align-items: flex-end; }
.hud-ab { position: relative; width: var(--s, 60px); height: var(--s, 60px); }
.hud-ab .hexbg, .hud-ab .hexfg, .hud-ab .sweep {
  position: absolute; inset: 0; clip-path: polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%);
}
.hud-ab .hexbg { background: linear-gradient(160deg, rgba(140,200,240,.5), rgba(80,130,170,.14)); }
.hud-ab .hexfg { inset: 2px; background: linear-gradient(165deg, rgba(20,34,46,.95), rgba(8,14,20,.92));
  display: grid; place-items: center; color: var(--c, #5fd8ff); }
.hud-ab .hexfg svg { width: 54%; height: 54%; filter: drop-shadow(0 0 6px currentColor); transition: opacity .25s linear; }
.hud-ab .sweep { inset: 2px; pointer-events: none;
  background: conic-gradient(rgba(2,5,8,0) 0 var(--p, 0%), rgba(2,5,8,.88) var(--p, 0%) 100%); }
.hud-ab .key {
  position: absolute; left: 50%; bottom: -18px; transform: translateX(-50%); white-space: nowrap;
  font-size: 9px; font-weight: 800; letter-spacing: .06em; color: var(--dim); text-shadow: var(--shadow);
  padding: 1px 6px 0; border: 1px solid var(--edge2); background: rgba(4,9,14,.55);
}
.hud-ab.ready .key { color: var(--c); }
.hud-ab .cd {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  font-size: 16px; font-weight: 800; font-style: italic; color: #fff; text-shadow: var(--shadow);
  opacity: 0; transition: opacity .2s linear;
}
.hud-ab.cooling .cd { opacity: 1; }
.hud-ab.cooling .hexfg svg { opacity: .3; }
.hud-ab .charges { position: absolute; left: 50%; top: -9px; transform: translateX(-50%); display: flex; gap: 3px; }
.hud-ab .charges i { display: block; width: 8px; height: 3px; background: var(--c); transform: skewX(-11deg); opacity: .95; }
.hud-ab .charges i.off { opacity: .18; }
@keyframes ready-flash {
  0% { box-shadow: 0 0 0 0 var(--c); opacity: 1; }
  100% { box-shadow: 0 0 0 22px transparent; opacity: 0; }
}
.hud-ab .flash { position: absolute; inset: 0; clip-path: polygon(50% 0, 100% 26%, 100% 74%, 50% 100%, 0 74%, 0 26%);
  background: var(--c); opacity: 0; }
@keyframes ready-pop { 0% { opacity: 0; transform: scale(1); } 18% { opacity: .85; transform: scale(1.14); }
  100% { opacity: 0; transform: scale(1.34); } }
.hud-ab .flash.go { animation: ready-pop .62s var(--ez) forwards; }
.hud-ab.ready .hexbg { animation: readyglow 1.9s ease-in-out infinite; }
@keyframes readyglow { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.75); } }
.hud-ab .pct { display: none; }

/* consumables */
.hud-items { display: flex; gap: 7px; align-items: flex-end; margin-left: 28px; padding-bottom: 2px; }
.hud-item {
  position: relative; width: 34px; height: 34px; display: grid; place-items: center;
  border: 1px solid var(--edge2); background: linear-gradient(160deg, rgba(12,20,28,.72), rgba(6,10,15,.6));
  clip-path: polygon(0 0, 100% 0, 100% 72%, 72% 100%, 0 100%);
  transition: opacity .3s linear;
}
.hud-item svg { width: 15px; height: 15px; color: var(--ic); fill: currentColor;
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--ic) 55%, transparent)); }
.hud-item b { position: absolute; right: 3px; top: 1px; font-size: 9.5px; font-weight: 800;
  color: #fff; text-shadow: var(--shadow); }
.hud-item.empty { opacity: .3; }
.hud-item.empty svg { filter: none; }

/* ============================================================ minimap === */
.hud-map { position: absolute; left: 30px; top: 28px; width: 208px; height: 208px; }
.hud-map canvas { position: absolute; inset: 0; }
.hud-map .frame {
  position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--edge);
  box-shadow: 0 0 22px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.5) inset;
}
.hud-map .cardinal {
  position: absolute; left: 50%; top: -9px; transform: translateX(-50%);
  font-size: 9px; font-weight: 800; letter-spacing: .2em; color: var(--acc2);
  background: rgba(6,10,15,.9); padding: 1px 6px; text-shadow: var(--shadow);
}
.hud-map .zoom { position: absolute; right: 2px; bottom: -2px; font-size: 8.5px; font-weight: 700;
  letter-spacing: .14em; color: var(--dim2); }

/* ============================================================ ring UI === */
.hud-ring { position: absolute; left: 30px; top: 250px; width: 208px; }
.hud-ring .top { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.hud-ring .top svg { width: 15px; height: 15px; color: var(--ringc, #b45cff); fill: currentColor; }
.hud-ring .stg { font-size: 10.5px; font-weight: 800; letter-spacing: .2em; color: var(--tx); text-shadow: var(--shadow); }
.hud-ring .state { font-size: 9px; font-weight: 700; letter-spacing: .18em; color: var(--ringc); margin-left: auto; }
.hud-ring .mid { display: flex; align-items: center; gap: 9px; }
.hud-ring .clock { font-size: 22px; font-weight: 800; font-style: italic; color: #fff; text-shadow: var(--shadow); line-height: 1; }
.hud-ring .arrow { width: 26px; height: 26px; color: var(--ringc); filter: drop-shadow(0 0 6px currentColor);
  transition: transform .12s linear; }
.hud-ring .dist { margin-left: auto; text-align: right; }
.hud-ring .dist b { display: block; font-size: 13px; font-weight: 700; color: var(--tx); font-style: italic; text-shadow: var(--shadow); }
.hud-ring .prog { position: relative; height: 3px; margin-top: 7px; background: rgba(255,255,255,.10); transform: skewX(-11deg); }
.hud-ring .prog i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ringc);
  box-shadow: 0 0 10px -1px var(--ringc); transition: width .4s linear; }
.hud-ring.urgent .clock { color: var(--bad); animation: blink .6s steps(1) infinite; }

/* =========================================================== kill feed == */
.hud-feed { position: absolute; right: 30px; top: 62px; width: 380px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.hud-kf {
  display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px 0 11px;
  background: linear-gradient(90deg, rgba(8,13,19,0), rgba(8,13,19,.82) 22%, rgba(8,13,19,.86));
  border-right: 2px solid var(--kfc, var(--dim2));
  transform-origin: right center; overflow: hidden; white-space: nowrap;
}
@keyframes kf-in { 0% { opacity: 0; transform: translateX(34px) scaleX(.9); }
  60% { opacity: 1; } 100% { opacity: 1; transform: none; } }
@keyframes kf-out { 0% { opacity: 1; max-height: 26px; } 70% { opacity: 0; max-height: 26px; }
  100% { opacity: 0; max-height: 0; margin-top: -5px; } }
.hud-kf.in { animation: kf-in .34s var(--ez) both; }
.hud-kf.out { animation: kf-out .5s ease-in forwards; }
.hud-kf .n { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-shadow: var(--shadow); }
.hud-kf .n.you { color: var(--acc); }
.hud-kf .n.ally { color: var(--cy); }
.hud-kf .n.foe { color: #e8eef4; }
.hud-kf .ic { display: flex; align-items: center; gap: 5px; color: var(--kfc, var(--tx)); }
.hud-kf .ic svg { height: 15px; fill: currentColor; }
.hud-kf .ic .w { width: 40px; }
.hud-kf .ic .m { width: 13px; height: 13px; opacity: .95; }
.hud-kf.self { background: linear-gradient(90deg, rgba(255,122,24,0), rgba(52,24,8,.86) 22%, rgba(58,26,8,.9)); }

/* ========================================================= match stats == */
.hud-stats { position: absolute; right: 30px; top: 26px; display: flex; gap: 16px; align-items: center; }
.hud-stats .s { text-align: right; }
.hud-stats .s b { display: block; font-size: 17px; font-weight: 800; font-style: italic;
  color: var(--tx); line-height: 1; text-shadow: var(--shadow); }
.hud-stats .s.hot b { color: var(--acc2); }
.hud-stats .div { width: 1px; height: 20px; background: var(--edge); }

/* ============================================================ compass === */
.hud-compass { position: absolute; left: calc(50% - 270px); top: 18px; }
.hud-compass canvas { display: block; }

/* ========================================================== overlays ==== */
.hud-vig { position: absolute; inset: 0; opacity: 0; transition: opacity .5s linear;
  background: radial-gradient(ellipse at 50% 50%, rgba(120,0,10,0) 34%, rgba(120,0,12,.5) 78%, rgba(80,0,6,.88) 100%); }
.hud-vig.on { animation: vigpulse 1.6s ease-in-out infinite; }
@keyframes vigpulse { 0%,100% { filter: brightness(.85); } 50% { filter: brightness(1.3); } }
.hud-desat { position: absolute; inset: 0; opacity: 0; transition: opacity .6s linear;
  background: rgba(90,10,16,.10); backdrop-filter: saturate(.45) contrast(1.06); }
.hud-back { position: absolute; inset: 0; pointer-events: none; }
.hud-hitflash { position: absolute; inset: 0; opacity: 0; background:
  radial-gradient(ellipse at 50% 50%, rgba(255,30,40,0) 46%, rgba(255,32,44,.34) 100%); }
@keyframes hitflash { 0% { opacity: .8; } 50% { opacity: .3; } 100% { opacity: 0; } }
.hud-hitflash.go { animation: hitflash .42s ease-out forwards; }

.hud-downed { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0;
  transition: opacity .45s var(--ez); }
.hud-downed.on { opacity: 1; }
.hud-downed .box { text-align: center; transform: translateY(84px); }
.hud-downed .ttl { font-size: 30px; font-weight: 800; letter-spacing: .42em; color: var(--bad);
  text-shadow: 0 0 24px rgba(255,50,60,.55), var(--shadow); }
.hud-downed .sub { font-size: 11px; font-weight: 700; letter-spacing: .3em; color: var(--dim); margin-top: 8px; }
.hud-downed .bleed { position: relative; width: 260px; height: 3px; margin: 14px auto 0; background: rgba(255,255,255,.12); transform: skewX(-11deg); }
.hud-downed .bleed i { position: absolute; inset: 0 auto 0 0; background: var(--bad); box-shadow: 0 0 12px -1px var(--bad); }

/* centre combat banner */
.hud-banner { position: absolute; left: 50%; top: 60%; transform: translateX(-50%); text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 4px; }
.hud-bn { opacity: 0; }
@keyframes bn-in { 0% { opacity: 0; transform: translateY(10px) scale(.96); } 12% { opacity: 1; transform: none; }
  76% { opacity: 1; } 100% { opacity: 0; transform: translateY(-8px); } }
.hud-bn.go { animation: bn-in 2.6s var(--ez) forwards; }
.hud-bn .t { font-size: 12px; font-weight: 800; letter-spacing: .34em; color: var(--acc2); text-shadow: var(--shadow); }
.hud-bn .v { font-size: 15px; font-weight: 700; letter-spacing: .2em; color: #fff; text-shadow: var(--shadow); }
.hud-bn.kill .t { color: var(--acc); }

/* ============================================================== canvas == */
.hud-dmgcanvas { position: absolute; inset: 0; }

/* ============================================================== pause === */
.hud-pause {
  position: absolute; inset: 0; pointer-events: none; opacity: 0; z-index: 20;
  background: radial-gradient(ellipse at 50% 45%, rgba(6,12,20,.72), rgba(2,4,7,.94));
  backdrop-filter: blur(5px) saturate(.9);
  transition: opacity .28s ease;
  display: grid; place-items: center;
}
.hud-pause.on { opacity: 1; pointer-events: auto; }
.hud-pause .panel {
  width: 760px; max-width: 92vw; background: linear-gradient(165deg, rgba(14,22,31,.96), rgba(7,11,16,.97));
  border: 1px solid var(--edge); box-shadow: 0 34px 90px rgba(0,0,0,.7);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 22px), calc(100% - 22px) 100%, 0 100%);
  transform: translateY(14px) scale(.985); transition: transform .34s var(--ez);
}
.hud-pause.on .panel { transform: none; }
.hud-pause .ph { display: flex; align-items: center; gap: 12px; padding: 18px 24px 14px;
  border-bottom: 1px solid var(--edge2); }
.hud-pause .ph svg { width: 17px; height: 17px; color: var(--acc); }
.hud-pause .ph h2 { font-size: 15px; font-weight: 800; letter-spacing: .34em; color: var(--tx); }
.hud-pause .ph .esc { margin-left: auto; font-size: 9px; letter-spacing: .22em; color: var(--dim2); font-weight: 700; }
.hud-pause .body { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 34px; padding: 20px 24px 22px; }
.hud-pause .grp { grid-column: span 2; font-size: 9px; font-weight: 800; letter-spacing: .28em;
  color: var(--acc2); margin: 10px 0 6px; }
.hud-pause .grp:first-child { margin-top: 0; }
.hud-row { display: flex; align-items: center; gap: 12px; height: 30px; }
.hud-row label { font-size: 10.5px; font-weight: 600; letter-spacing: .14em; color: var(--dim); flex: 1; }
.hud-row .val { font-size: 11px; font-weight: 800; color: var(--tx); width: 46px; text-align: right; font-style: italic; }
.hud-row input[type=range] { -webkit-appearance: none; appearance: none; width: 152px; height: 3px;
  background: rgba(255,255,255,.14); outline: none; }
.hud-row input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 9px; height: 15px;
  background: var(--acc); cursor: pointer; box-shadow: 0 0 10px -1px var(--acc); transform: skewX(-11deg); }
.hud-row input[type=range]::-moz-range-thumb { width: 9px; height: 15px; border: 0; background: var(--acc);
  cursor: pointer; }
.hud-tog { width: 46px; height: 17px; background: rgba(255,255,255,.09); position: relative;
  transform: skewX(-11deg); cursor: pointer; border: 1px solid var(--edge2); transition: background .2s; }
.hud-tog i { position: absolute; left: 2px; top: 2px; width: 19px; bottom: 2px; background: var(--dim2);
  transition: transform .22s var(--ez), background .2s; }
.hud-tog.on { background: rgba(255,122,24,.18); border-color: rgba(255,122,24,.5); }
.hud-tog.on i { transform: translateX(21px); background: var(--acc); box-shadow: 0 0 10px -1px var(--acc); }
.hud-pause .pf { display: flex; gap: 10px; padding: 0 24px 22px; }
.hud-btn {
  font-family: inherit;
  padding: 9px 20px; font-size: 10px; font-weight: 800; letter-spacing: .26em; color: var(--tx);
  background: rgba(255,255,255,.05); border: 1px solid var(--edge); cursor: pointer;
  transform: skewX(-11deg); transition: background .18s, color .18s, border-color .18s;
}
.hud-btn > span { display: block; transform: skewX(11deg); }
.hud-btn:hover { background: rgba(255,122,24,.18); border-color: var(--acc); color: #fff; }
.hud-btn.primary { background: linear-gradient(90deg, rgba(255,122,24,.32), rgba(255,122,24,.12)); border-color: var(--acc); }

/* hint strip bottom centre */
.hud-hint { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  font-size: 9px; font-weight: 700; letter-spacing: .24em; color: rgba(147,170,189,.5);
  text-shadow: var(--shadow); }
.hud-hint b { color: var(--acc2); font-weight: 800; }
`;

export function injectStyles(root) {
  const s = document.createElement('style');
  s.id = 'hud-style';
  s.textContent = CSS;
  root.appendChild(s);
  return s;
}
