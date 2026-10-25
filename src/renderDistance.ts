// M1: every render-distance slider (the 3D pane's own, the ribbon 3D tab, Settings) shares one
// floor/ceiling — they used to disagree (1–16 / 2–32 / 2–32), so the ribbon slider could push
// `loadRadius` to 1 (below the pane's own floor, breaking `radiusToPos`) and couldn't reach 17–32,
// silently clamping a value Settings had just set the next time it was touched.
// 23.11: lives outside FlyView3D.tsx so the ribbon/Settings don't statically pull three.js into the
// startup bundle — FlyView3D is `React.lazy`-loaded by App.
export const MAX_RENDER_DISTANCE = 32; // slider ceiling (chunk radius)
export const RD_MIN = 2;               // slider floor (chunk radius)
