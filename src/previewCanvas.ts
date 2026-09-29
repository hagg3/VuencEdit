/** Decoded-preview canvas memo (audit RAM-6b). The preview panels used to allocate a fresh offscreen
 *  canvas + `ImageData` on every redraw — pointer-rate while panning/zooming the elevation panel —
 *  abandoning each backing store to GC. The decode is now done once per pixel buffer and reused.
 *
 *  Keyed weakly on the RGBA `Uint8Array` itself (its identity changes exactly when a new preview
 *  arrives, and it is what the caller already holds), so replacing the preview drops the old canvas
 *  with it — no manual zeroing/eviction needed. Treat the returned canvas as read-only. */
const cache = new WeakMap<Uint8Array, HTMLCanvasElement>();

export function previewCanvas(p: { width: number; height: number; pixels: Uint8Array }): HTMLCanvasElement {
  let c = cache.get(p.pixels);
  if (c && c.width === p.width && c.height === p.height) return c;
  c = document.createElement("canvas");
  c.width = p.width;
  c.height = p.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(p.width, p.height);
  img.data.set(p.pixels);
  ctx.putImageData(img, 0, 0);
  cache.set(p.pixels, c);
  return c;
}
