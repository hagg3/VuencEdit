// Shared base64 → typed-array decoders for IPC payloads (pixel patches,
// geometry buffers, texture atlases). Rust encodes via `serialize_bytes_b64`;
// every component decodes through here instead of hand-rolling atob loops.

export function decodeU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Encode a byte array to base64 for IPC payloads flowing JS → Rust (e.g. a lasso selection
 *  bitset for `set_selection_mask`). Inverse of `decodeU8`; chunked so a large buffer doesn't blow
 *  the argument limit of `String.fromCharCode(...spread)`. */
export function encodeU8(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function decodeF32(b64: string): Float32Array {
  const bytes = decodeU8(b64);
  // Length in floats via (n >> 2) guards against a payload whose byteLength
  // isn't a multiple of 4 — the Float32Array ctor throws on ragged buffers.
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}
