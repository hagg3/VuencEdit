/**
 * Paste-mode key resolver (row 32.5 / D12). Pure: maps a keydown to the command id a `paste`-scope
 * chord in `meta.ts` binds, and only while the paste tool is armed with a clipboard. App's keydown
 * handler calls this *before* the global single-letter tool keys, so paste-mode R rotates the
 * clipboard instead of arming Rectangle (see `PASTE_SHADOWS` in keys.ts).
 */
import { matchChord, type KeyLike } from "./keys";
import { meta, type CommandId } from "./meta";

/** The commands whose paste-scope chord App dispatches through this resolver. (PageUp/PageDown and
 *  `.` carry payloads — step size, last delta — and keep their own branches in App.) */
export const PASTE_KEY_COMMANDS: readonly CommandId[] = [
  "home.clipboard.rotate", "home.clipboard.rotateCcw", "home.clipboard.flipX", "home.clipboard.flipY",
];

export function resolvePasteKey(
  e: KeyLike, ctx: { tool: string; hasClipboard: boolean; typing: boolean }, mac?: boolean,
): CommandId | null {
  if (ctx.tool !== "paste" || !ctx.hasClipboard || ctx.typing) return null;
  for (const id of PASTE_KEY_COMMANDS) {
    if (meta(id).keys?.some(c => c.scope === "paste" && matchChord(e, c, mac))) return id;
  }
  return null;
}
