// Binary IPC decoding for payloads flowing Rust → JS (pixel patches, previews,
// geometry buffers, texture atlases), plus the one base64 encoder still used in
// the JS → Rust direction.
//
// Payload-carrying commands return a raw `tauri::ipc::Response` (audit H2), which
// `invoke` hands back as an `ArrayBuffer` — no base64, no JSON string, no per-byte
// decode loop. The framing every such command uses (see `ipc_envelope` in lib.rs):
//
//     [0..4]              u32 LE   header_len
//     [4 .. 4+header_len] JSON     the scalar fields
//     [4+header_len ..]   raw      the byte buffers, concatenated
//
// Decode with `decodeEnvelope`; split multi-buffer bodies with `splitBody`.

/** The raw shape `invoke` resolves to for an envelope-framed command. `ArrayBuffer` is what the
 *  custom-protocol IPC delivers; the other forms are what Tauri's `postMessage` fallback produces
 *  if the custom protocol is ever unavailable, and cost nothing to tolerate. */
export type IpcBinary = ArrayBuffer | Uint8Array | number[];

function asBytes(buf: IpcBinary): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (Array.isArray(buf)) return Uint8Array.from(buf);
  return new Uint8Array(buf);
}

/** Split a binary IPC response into its JSON header and the raw body that follows it.
 *  `body` is a *view* over the response bytes — no copy is made. */
export function decodeEnvelope<H>(buf: IpcBinary): { header: H; body: Uint8Array } {
  const bytes = asBytes(buf);
  if (bytes.length < 4) throw new Error("Malformed IPC envelope: shorter than its length prefix");
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (4 + headerLen > bytes.length) throw new Error("Malformed IPC envelope: header runs past the response");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen))) as H;
  return { header, body: bytes.subarray(4 + headerLen) };
}

/** Slice a multi-buffer envelope body into the buffers named by the header's `lens` array.
 *  Each result is a view over the same underlying bytes. */
export function splitBody(body: Uint8Array, lens: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  for (const len of lens) {
    out.push(body.subarray(off, off + len));
    off += len;
  }
  return out;
}

/** Reinterpret an envelope byte range as LE `Int16`/`Uint16`/`Uint32`s (the compact geometry
 *  streams, ROADMAP-EDIT 18.14) — a view, copying only when the range is misaligned for the element
 *  size (typed arrays require it). `count` caps the element count: an index section is zero-padded
 *  to 4 bytes past its last index. */
export function asI16(bytes: Uint8Array, count = bytes.byteLength >> 1): Int16Array {
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, count);
  return new Int16Array(bytes.slice(0, count * 2).buffer);
}
export function asU16(bytes: Uint8Array, count = bytes.byteLength >> 1): Uint16Array {
  if (bytes.byteOffset % 2 === 0) return new Uint16Array(bytes.buffer, bytes.byteOffset, count);
  return new Uint16Array(bytes.slice(0, count * 2).buffer);
}
export function asU32(bytes: Uint8Array, count = bytes.byteLength >> 2): Uint32Array {
  if (bytes.byteOffset % 4 === 0) return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
  return new Uint32Array(bytes.slice(0, count * 4).buffer);
}

/** Encode a byte array to base64 for IPC payloads flowing JS → Rust (e.g. a lasso selection
 *  bitset for `set_selection_mask`). Chunked so a large buffer doesn't blow the argument limit
 *  of `String.fromCharCode(...spread)`. */
export function encodeU8(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
