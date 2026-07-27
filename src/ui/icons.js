/**
 * All HUD iconography is inline SVG generated here — no image files, no fonts.
 * Icons are drawn as technical silhouettes (viewBox 0 0 48 20 for weapons,
 * 0 0 24 24 for glyphs) so they stay legible at 14-20px.
 */

const W = {
  ar: `<rect x="7" y="8" width="26" height="3.4"/><rect x="33" y="8.6" width="9" height="2.2"/>
       <rect x="7" y="8" width="13" height="6.2"/><path d="M15 14.2h5.4l-1.4 5.8h-5.6z"/>
       <path d="M1.5 8.2h5.5v6.6l-5.5-2.2z"/><rect x="9" y="5.6" width="11" height="1.6"/>
       <rect x="24" y="11.4" width="2.6" height="3.4"/>`,
  smg: `<rect x="10" y="8" width="18" height="3.4"/><rect x="28" y="8.6" width="6" height="2.2"/>
        <rect x="10" y="8" width="11" height="6"/><path d="M16 14h5.2l-2.6 6h-5.4z"/>
        <path d="M4 8.4h6v5.4l-6-1.8z"/><rect x="11" y="5.8" width="8" height="1.5"/>`,
  lmg: `<rect x="9" y="7.4" width="27" height="3.2"/><rect x="36" y="8" width="7" height="2"/>
        <rect x="9" y="7.4" width="12" height="5.6"/><circle cx="17" cy="15.4" r="4.4"/>
        <path d="M2 7.6h7v5.8l-7-2z"/><rect x="11" y="5" width="10" height="1.6"/>`,
  sniper: `<rect x="8" y="9" width="34" height="2.6"/><rect x="42" y="9.4" width="4" height="1.8"/>
        <rect x="8" y="8.4" width="11" height="5.4"/><rect x="12" y="3.6" width="15" height="3.2"/>
        <rect x="10.5" y="4.4" width="2" height="1.8"/><path d="M13 13.8h4.6l-1 5.4h-4.8z"/>
        <path d="M1 8.6h7v5.6l-7-1.8z"/><path d="M30 11.6l3 5.4M36 11.6l-3 5.4" stroke="currentColor" stroke-width="1.5" fill="none"/>`,
  shotgun: `<rect x="8" y="7.2" width="30" height="3"/><rect x="8" y="11" width="30" height="2.6"/>
        <rect x="16" y="13.8" width="12" height="2.4"/><rect x="8" y="7.2" width="9" height="6.4"/>
        <path d="M1 7.6h7v6.4l-7-2z"/>`,
  pistol: `<rect x="15" y="7.4" width="20" height="3.6"/><rect x="15" y="7.4" width="9" height="5.4"/>
        <path d="M17.5 12.4h6.5l-2.6 7.4h-6.3z"/><rect x="34" y="8" width="3" height="2.4"/>`,
  melee: `<path d="M5 14.5 30 3.5l5 4.4L10 19z"/><rect x="1" y="13" width="6" height="4" rx="1"/>`,
  grenade: `<circle cx="24" cy="12.4" r="6.2"/><rect x="21.4" y="2.6" width="5.2" height="3.4"/>
        <path d="M26.6 4.2h6v2h-6z"/>`,
  ring: `<circle cx="24" cy="10" r="7.4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="4.2 3.4"/>
        <circle cx="24" cy="10" r="2.2"/>`,
  fall: `<path d="M24 1.5v9.5" stroke="currentColor" stroke-width="2.6" fill="none"/>
        <path d="M18.5 8.5 24 14.5 29.5 8.5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linejoin="miter"/>
        <rect x="12" y="16.6" width="24" height="2.6"/>`,
  ability: `<path d="M24 2.2 32 7v9.6L24 21l-8-4.4V7z" fill="none" stroke="currentColor" stroke-width="2.4"/>
        <circle cx="24" cy="11.6" r="2.6"/>`,
};

export function weaponIcon(kind) {
  return W[kind] || W.ar;
}

/** Small marks used inline in the kill feed. */
export const MARK = {
  headshot: `<circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="2"/>
             <circle cx="12" cy="12" r="2.4"/><path d="M12 1.6v4M12 18.4v4M1.6 12h4M18.4 12h4" stroke="currentColor" stroke-width="2"/>`,
  knock: `<path d="M4 17.5 12 4l8 13.5z" fill="none" stroke="currentColor" stroke-width="2.2"/>
          <rect x="10.8" y="8.5" width="2.4" height="5"/><rect x="10.8" y="14.6" width="2.4" height="2.2"/>`,
  skull: `<path d="M12 2.4c-4.6 0-7.6 3-7.6 7 0 2.4 1 3.8 2.2 4.8V18h10.8v-3.8c1.2-1 2.2-2.4 2.2-4.8 0-4-3-7-7.6-7z" fill="none" stroke="currentColor" stroke-width="2"/>
           <circle cx="9" cy="9.6" r="1.9"/><circle cx="15" cy="9.6" r="1.9"/><rect x="10.6" y="19.4" width="2.8" height="2.6"/>`,
  squad: `<path d="M12 2 21 7v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="2"/>`,
};

/** Legend ability glyphs — abstract, angular, drawn on a 24x24 grid. */
export const GLYPH = {
  tactical: `<path d="M12 2.5 4 8v8l8 5.5 8-5.5V8z" fill="none" stroke="currentColor" stroke-width="1.7" opacity=".55"/>
             <path d="M12 6.4 16.8 9.8v6.2L12 19.2 7.2 16V9.8z" fill="currentColor" opacity=".9"/>
             <path d="M12 9.6v6M9 12h6" stroke="#0a1016" stroke-width="1.8"/>`,
  ultimate: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
             <path d="M12 3.2 14.6 9.4 21 12l-6.4 2.6L12 20.8 9.4 14.6 3 12l6.4-2.6z" fill="currentColor"/>`,
  legend: `<path d="M12 1.6 21.5 7v10L12 22.4 2.5 17V7z" fill="none" stroke="currentColor" stroke-width="1.6"/>
           <path d="M12 6 17 9v6l-5 3-5-3V9z" fill="currentColor" opacity=".28"/>
           <path d="M8.4 15.2 12 7.6l3.6 7.6" fill="none" stroke="currentColor" stroke-width="1.9"/>`,
};

/** Consumable glyphs (24x24). */
export const ITEM = {
  syringe: `<rect x="9.5" y="4" width="5" height="12" rx="1"/><rect x="10.8" y="16" width="2.4" height="5"/>
            <rect x="8" y="2" width="8" height="2.4"/><rect x="10.4" y="7" width="3.2" height="6" fill="#0a1016"/>`,
  medkit: `<rect x="3" y="6.5" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2.1"/>
           <path d="M12 9.6v7M8.5 13.1h7" stroke="currentColor" stroke-width="2.4"/>
           <rect x="9" y="3.6" width="6" height="2.6"/>`,
  cell: `<rect x="7" y="5.5" width="10" height="15" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>
         <rect x="9.8" y="2.6" width="4.4" height="2.6"/><rect x="9.2" y="13" width="5.6" height="5.6"/>`,
  battery: `<rect x="7" y="5.5" width="10" height="15" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>
            <rect x="9.8" y="2.6" width="4.4" height="2.6"/><rect x="9.2" y="8" width="5.6" height="10.6"/>`,
};

export const UIICON = {
  gear: `<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z" fill="none" stroke="currentColor" stroke-width="1.8"/>
         <path d="M19.4 12a7.6 7.6 0 0 0-.14-1.4l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2.4-1.4L14.2 2.8H9.8l-.36 2.5a7.4 7.4 0 0 0-2.4 1.4l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.8l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2.4 1.4l.36 2.5h4.4l.36-2.5a7.4 7.4 0 0 0 2.4-1.4l2.3 1 2-3.4-2-1.5c.1-.46.14-.92.14-1.4z"
         fill="none" stroke="currentColor" stroke-width="1.5"/>`,
  ping: `<path d="M12 2.6c-3.6 0-6.4 2.8-6.4 6.3C5.6 13.6 12 21.4 12 21.4s6.4-7.8 6.4-12.5c0-3.5-2.8-6.3-6.4-6.3z" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="9" r="2.4"/>`,
};
