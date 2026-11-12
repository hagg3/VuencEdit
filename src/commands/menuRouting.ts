/**
 * Pure routing rules for the macOS menu bar (34.1, plan §5): when a menu item is enabled, what a
 * click or accelerator does, and the 250 ms echo dedupe. No React, no Tauri — `commands.test.ts`
 * covers it in node, and `nativeMenu.ts` / App feed it live state.
 *
 * The rules mirror App's keydown handler **in the same order**, so a menu click can never do
 * something the key path refuses.
 */
import type { CommandId } from "./meta";
import { meta } from "./meta";
import type { CommandBinding } from "./types";
import { SPLASH_SAFE, TEXT_FORWARD, isCheckItem, type NativeEditAction } from "./menuBar";

/** Why the editor isn't taking commands right now. `help` = the Help panel is up; `modal` covers every
 *  dialog, the tour, a confirm and a running long operation; `loading` = a world is being parsed. */
export type MenuBlock = "none" | "modal" | "help" | "loading";

export interface MenuGate {
  blocked: MenuBlock;
  /** Ribbon bindings exist, so a world is open. */
  hasWorld: boolean;
}

/** Items that stay live behind a modal: Quit (App's close guard prompts), and Help's own toggle in Help. */
function passesBlock(id: CommandId, blocked: MenuBlock): boolean {
  if (id === "app.quit") return true;
  if (blocked === "help") return id === "app.help";
  return blocked === "none";
}

export type MenuDecision =
  | { kind: "drop" }
  | { kind: "forward"; action: NativeEditAction }
  | { kind: "notice"; text: string }
  | { kind: "run" };

/**
 * What `runMenuCommand` does with `id`. Order matters:
 *
 * 1. A text field is focused → the six Edit items go to the native responder (also inside a modal:
 *    Settings has text fields). ⌘D (Deselect) is dropped there: App's keydown handler leaves ⌘D to the
 *    field, so the accelerator falling through to the menu must not clear the map selection.
 * 2. Blocked by a modal / Help / a load → drop (Quit and Help's toggle excepted).
 * 3. No world → only the splash-safe set.
 * 4. Otherwise the binding's own gate: a reason becomes a notice, `true` runs.
 */
export function decideMenuAction(
  id: CommandId, typing: boolean, gate: MenuGate, binding: Pick<CommandBinding, "enabled"> | undefined,
): MenuDecision {
  if (typing) {
    const action = TEXT_FORWARD[id];
    if (action) return { kind: "forward", action };
    if (id === "home.selection.clear") return { kind: "drop" };
  }
  if (!passesBlock(id, gate.blocked)) return { kind: "drop" };
  if (!gate.hasWorld && !SPLASH_SAFE.has(id)) return { kind: "drop" };
  if (!binding) return { kind: "drop" };
  if (binding.enabled !== true) return { kind: "notice", text: binding.enabled };
  return { kind: "run" };
}

export interface MenuItemState {
  enabled: boolean;
  text: string;
  /** Only for check items; `null` for plain ones. */
  checked: boolean | null;
}

/** What a menu item should show right now. The six text-capable Edit items and Quit are never greyed. */
export function menuItemState(
  id: CommandId, gate: MenuGate, binding: CommandBinding | undefined,
): MenuItemState {
  const alwaysOn = id in TEXT_FORWARD || id === "app.quit";
  const live = passesBlock(id, gate.blocked) && (gate.hasWorld || SPLASH_SAFE.has(id)) && binding?.enabled === true;
  return {
    enabled: alwaysOn || live,
    text: binding?.labelOverride ?? meta(id).label,
    checked: isCheckItem(id) ? !!binding?.armed : null,
  };
}

// ── Echo dedupe ──────────────────────────────────────────────────────────────────────────────────

/** A menu accelerator that App's keydown handler already ran is dropped within this window. */
export const ECHO_MS = 250;

export interface KeyStamp { id: string; t: number }

export function shouldDropMenuEcho(last: KeyStamp | null, id: string, now: number): boolean {
  return !!last && last.id === id && now >= last.t && now - last.t < ECHO_MS;
}

let lastKeyCmd: KeyStamp | null = null;

/** The legacy keydown handler (or ⌘K's capture listener) just handled this command's chord. */
export function noteKeyCommand(id: string, now = performance.now()): void {
  lastKeyCmd = { id, t: now };
}

/** `runMenuCommand`'s first check. */
export function isMenuEcho(id: string, now = performance.now()): boolean {
  return shouldDropMenuEcho(lastKeyCmd, id, now);
}
