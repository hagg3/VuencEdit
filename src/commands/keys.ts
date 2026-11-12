/**
 * Keyboard chords for the command registry (UI redesign r3, 14.6): the data shape, platform-aware
 * display, event matching, and the scope-overlap rule the shortcut-collision test enforces.
 *
 * Pure — no React, no DOM beyond the `KeyboardEvent`-shaped object `matchChord` reads — so the
 * collision test and Help's table can load it in node.
 */

/**
 * Where a chord is live. Two commands may share a chord only when their scopes never overlap:
 *
 * - `global` — App's editor keydown handler, any time a world is open and focus isn't in a text field.
 * - `select` / `paste` / `sculpt` — only while that tool family is armed (App checks `appToolRef`).
 * - `3d` — the 3D pane's own listener (camera cycle), while it has the pointer.
 * - `walk` — while the fly camera is walking: App's handler **returns early** for unmodified keys,
 *   so global letter shortcuts are dead there. That's why `walk` doesn't overlap `global`.
 * - `work-area` — Tab-swap: only with focus on the body, a viewport canvas or a window title bar.
 * - `stroke` — modifiers held *during* a sculpt stroke (read by MapCanvas off the pointer event).
 */
export type ChordScope = "global" | "select" | "paste" | "sculpt" | "3d" | "walk" | "work-area" | "stroke";

export interface Chord {
  /** `KeyboardEvent.key`, compared case-insensitively ("s", "Delete", "ArrowUp", "["). */
  key?: string;
  /** `KeyboardEvent.code`, for ⌥ combos whose `key` is layout-dependent (⌥3 types "£" on a Mac). */
  code?: string;
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Press-and-hold (Space pan, Ctrl invert) — display prefix only. */
  hold?: boolean;
  /** Display-only: skip this chord in Help on a Mac (e.g. ⌘Y, which means nothing there). Matching ignores it. */
  hideOnMac?: true;
  scope: ChordScope;
}

/** Which scopes can be live at the same moment. Symmetric; the test asserts it. */
const OVERLAPS: Record<ChordScope, readonly ChordScope[]> = {
  global: ["global", "select", "paste", "sculpt", "3d", "work-area", "stroke"],
  select: ["global", "select"],
  paste: ["global", "paste"],
  sculpt: ["global", "sculpt", "stroke"],
  "3d": ["global", "3d", "walk"],
  walk: ["walk", "3d"],
  "work-area": ["global", "work-area"],
  stroke: ["global", "sculpt", "stroke"],
};

export function scopesOverlap(a: ChordScope, b: ChordScope): boolean {
  return OVERLAPS[a].includes(b);
}

export const ALL_SCOPES = Object.keys(OVERLAPS) as ChordScope[];

/** The identity two chords collide on: the physical key + the modifier set. */
export function chordKey(c: Chord): string {
  const k = c.code ? `code:${c.code}` : `key:${(c.key ?? "").toLowerCase()}`;
  return `${c.mod ? "M" : ""}${c.shift ? "S" : ""}${c.alt ? "A" : ""}|${k}`;
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

const KEY_GLYPH: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  pageup: "PgUp", pagedown: "PgDn", escape: "Esc", " ": "Space", delete: "Del", backspace: "⌫",
  home: "Home", tab: "Tab", shift: "Shift", "=": "+",
};

/** `code` → the character printed on a US keycap, for display of ⌥ combos. */
function codeLabel(code: string): string {
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Key")) return code.slice(3);
  return code;
}

/** The chord's key glyph alone — no modifiers. */
export function keyLabel(c: Chord, mac = isMacPlatform()): string {
  if (c.code) return codeLabel(c.code);
  const raw = c.key ?? "";
  const g = KEY_GLYPH[raw.toLowerCase()];
  if (raw.toLowerCase() === "control") return mac ? "⌃" : "Ctrl";
  if (raw.toLowerCase() === "meta") return mac ? "⌘" : "Win";
  if (g) return raw.toLowerCase() === "backspace" && !mac ? "Backspace" : g;
  if (raw === "-") return mac ? "−" : "Minus";
  return raw.length === 1 ? raw.toUpperCase() : raw;
}

/**
 * Display parts, in order, e.g. `["⌘", "⇧", "S"]` on macOS, `["Ctrl", "Shift", "S"]` elsewhere.
 * Help renders each part as its own keycap; `formatChord` joins them.
 */
export function chordParts(c: Chord, mac = isMacPlatform()): string[] {
  const parts: string[] = [];
  if (c.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (c.alt) parts.push(mac ? "⌥" : "Alt");
  if (c.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(keyLabel(c, mac));
  return parts;
}

/** One string for a keycap / tooltip: "⌘⇧S" on macOS, "Ctrl+Shift+S" elsewhere. */
export function formatChord(c: Chord, mac = isMacPlatform()): string {
  const s = chordParts(c, mac).join(mac ? "" : "+");
  return c.hold ? `Hold ${s}` : s;
}

/**
 * Is the platform's primary modifier down with the other one up? (⌘ and not Ctrl on a Mac; Ctrl and
 * not ⌘ elsewhere.) The same rule `matchChord` uses, so Control chords never reach app shortcuts on a Mac.
 */
export function primaryModDown(e: Pick<KeyLike, "metaKey" | "ctrlKey">, mac = isMacPlatform()): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Just the event fields `matchChord` reads, so tests can pass plain objects. */
export interface KeyLike {
  key: string; code: string;
  metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
}

/**
 * Does this keydown fire the chord? `mod` is ⌘ on macOS and Ctrl elsewhere — and the *other* one
 * must be up, so Ctrl+K on a Mac and ⌘K via a remapped Windows keyboard don't fire. ⌥ chords
 * additionally require Ctrl up: Windows **AltGr** arrives as Ctrl+Alt, and an AltGr character
 * (AltGr+3 = "³" on EU layouts) must never trigger a window toggle.
 */
export function matchChord(e: KeyLike, c: Chord, mac = isMacPlatform()): boolean {
  const modDown = mac ? e.metaKey : e.ctrlKey;
  const otherDown = mac ? e.ctrlKey : e.metaKey;
  if (!!c.mod !== modDown || otherDown) return false;
  if (!!c.alt !== e.altKey) return false;
  if (!!c.shift !== e.shiftKey) return false;
  if (c.code) return e.code === c.code;
  return (c.key ?? "").toLowerCase() === e.key.toLowerCase();
}

/**
 * The chord as a Tauri/muda menu accelerator string (34.1): `CmdOrCtrl[+Shift][+Alt]+<Key>`, or `null`
 * when the chord must not become one. **Only `mod` chords qualify**: a menu key equivalent fires even
 * with a text field focused, so a bare key (`S`, `?`, `Delete`, `Tab`) or a ⌥ chord (⌥T types "†")
 * would steal typing. Those items keep no accelerator; Help and tooltips still show the chord.
 * `=`, `-`, `,` and digits are the literal characters muda 0.19's parser accepts (pinned in a test).
 */
export function chordToAccelerator(c: Chord): string | null {
  if (!c.mod || c.code || !c.key) return null;
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return ["CmdOrCtrl", c.shift ? "Shift" : "", c.alt ? "Alt" : "", key].filter(Boolean).join("+");
}

/** The accelerator a menu item shows: the first of the command's chords that qualifies. */
export function firstAccelerator(keys: readonly Chord[] | undefined): string | null {
  for (const c of keys ?? []) {
    const a = chordToAccelerator(c);
    if (a) return a;
  }
  return null;
}
