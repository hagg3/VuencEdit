import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEnvelope } from "./codec";
import { putPatchPixels } from "./viewportUtils";

// `ImageData` is a browser global VuencEdit never polyfills in this node-environment vitest suite
// (see CLAUDE.md's "vitest here is node-environment" note). This is the one piece of its contract
// every call site in this codebase actually depends on: the constructor throws unless
// `data.length === 4 * width * height` exactly (Chromium/WebKit both enforce this per spec). A
// bug that hands the constructor the *whole* IPC envelope buffer instead of just the pixel slice
// therefore throws synchronously — which is exactly what crashed New World's "Preview terrain"
// (NewWorldModal.tsx's `PreviewCanvas` effect, pre-existing in the code before the 14.15 colour
// migration). Stubbing just this one invariant lets that class of bug be caught here without a
// real DOM.
class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    if (data.length !== 4 * width * height) {
      throw new Error(
        `Failed to construct 'ImageData': The input data length (${data.length}) is not equal ` +
        `to (4 * width * height) (${4 * width * height})`,
      );
    }
    this.data = data; this.width = width; this.height = height;
  }
}

function buildEnvelope(header: unknown, body: Uint8Array): ArrayBuffer {
  let hdr = new TextEncoder().encode(JSON.stringify(header));
  // Mirror `ipc_envelope`'s space-padding to a 4-byte-aligned body start (lib.rs).
  const pad = (4 - ((4 + hdr.length) % 4)) % 4;
  if (pad > 0) hdr = new Uint8Array([...hdr, ...new Uint8Array(pad).fill(0x20)]);
  const out = new Uint8Array(4 + hdr.length + body.length);
  new DataView(out.buffer).setUint32(0, hdr.length, true);
  out.set(hdr, 4);
  out.set(body, 4 + hdr.length);
  // Wrap in a *larger* backing ArrayBuffer so `body`'s eventual `.buffer` is never accidentally
  // the same size as `body` itself — matching how a real webview response is a single contiguous
  // buffer this envelope's body is only a tail slice of.
  return out.buffer;
}

describe("decodeEnvelope body view", () => {
  it("body is a subarray whose own .buffer is the WHOLE envelope, not just the body bytes", () => {
    const width = 4, height = 3;
    const pixels = new Uint8Array(4 * width * height).fill(0x7f);
    const buf = buildEnvelope({ width, height }, pixels);
    const { header, body } = decodeEnvelope<{ width: number; height: number }>(buf);

    expect(header).toEqual({ width, height });
    expect(body.byteLength).toBe(pixels.byteLength);
    // The trap: body.buffer is the envelope's buffer (length prefix + header + body), strictly
    // bigger than body itself whenever the header is non-empty.
    expect(body.buffer.byteLength).toBeGreaterThan(body.byteLength);
    expect(body.byteOffset).toBeGreaterThan(0);
  });
});

describe("putPatchPixels (regression for the New World preview-terrain crash)", () => {
  let calls: unknown[][];
  let ctx: { putImageData: (...args: unknown[]) => void };

  beforeEach(() => {
    (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
    calls = [];
    ctx = { putImageData: (...args: unknown[]) => { calls.push(args); } };
  });
  afterEach(() => {
    delete (globalThis as { ImageData?: unknown }).ImageData;
  });

  it("re-views pixels at their own byteOffset/byteLength, so ImageData construction succeeds", () => {
    const width = 4, height = 3;
    const pixels = new Uint8Array(4 * width * height).fill(0x40);
    const buf = buildEnvelope({ width, height }, pixels);
    const { body } = decodeEnvelope<{ width: number; height: number }>(buf);

    expect(() => putPatchPixels(ctx as unknown as CanvasRenderingContext2D, { width, height, pixels: body }))
      .not.toThrow();
    expect(calls).toHaveLength(1);
    const img = calls[0][0] as FakeImageData;
    expect(img.data.length).toBe(4 * width * height);
  });

  it("documents the bug: constructing ImageData from the RAW envelope .buffer throws", () => {
    const width = 4, height = 3;
    const pixels = new Uint8Array(4 * width * height).fill(0x40);
    const buf = buildEnvelope({ width, height }, pixels);
    const { body } = decodeEnvelope<{ width: number; height: number }>(buf);

    // This is the exact pattern NewWorldModal.tsx used before the fix:
    //   new ImageData(new Uint8ClampedArray(preview.pixels.buffer), preview.width, preview.height)
    expect(() => new FakeImageData(new Uint8ClampedArray(body.buffer), width, height)).toThrow(
      /input data length/,
    );
  });
});
