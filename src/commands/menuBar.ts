/**
 * The macOS menu bar's layout (34.1, `macos-menu-bar-plan-2026-11-10.md` §4) — **structure only**. Label,
 * accelerator, kind and enabled/checked state all come from `meta.ts` / `bind.ts`; this file just says
 * which command goes where. Pure data (no Tauri import) so `commands.test.ts` can guard it in node.
 *
 * Why generated from the registry rather than hand-written: a hand-copied list is exactly the drift
 * the registry exists to prevent. The test asserts every id exists, appears once, has a menu-safe
 * `kind`, and that every `path: APP` command is either here or in `MENU_BAR_EXCLUDED` with a reason.
 */
import { meta, type CommandId } from "./meta";
import { matchChord, chordToAccelerator, type KeyLike } from "./keys";

/** Items AppKit owns outright (predefined by muda): text, shortcut and behaviour are the OS's. */
export type NativeItem =
  | "services" | "hide" | "hideOthers" | "showAll"
  | "fullscreen" | "minimize" | "zoom" | "bringAllToFront";

export type MenuEntry =
  | "sep"
  | { id: CommandId }
  | { native: NativeItem }
  /** The File ▸ Open Recent submenu, rebuilt from the recent-worlds list. */
  | { recent: true };

export interface MenuSpec {
  title: string;
  items: readonly MenuEntry[];
  /** `windows` → `setAsWindowsMenuForNSApp` (AppKit appends the window list); `help` → the Help search field. */
  role?: "windows" | "help";
}

const c = (id: CommandId): MenuEntry => ({ id });
const n = (native: NativeItem): MenuEntry => ({ native });

export const MENU_BAR: readonly MenuSpec[] = [
  { title: "VuencEdit", items: [
    c("app.about"), "sep", c("app.settings"), "sep", n("services"), "sep",
    n("hide"), n("hideOthers"), n("showAll"), "sep", c("app.quit"),
  ] },
  { title: "File", items: [
    c("app.new"), c("app.open"), { recent: true }, c("app.download"), "sep",
    c("app.close"), c("app.save"), c("app.saveAs"), "sep",
    c("app.exportPng"), c("app.upload"), "sep", c("app.properties"),
  ] },
  { title: "Edit", items: [
    c("app.undo"), c("app.redo"), "sep",
    c("home.clipboard.cut"), c("home.clipboard.copy"), c("home.clipboard.paste"), "sep",
    c("selection.modify.selectAll"), c("home.selection.clear"), "sep",
    c("home.selection.delete"), c("home.selection.fill"), "sep",
    c("app.goto"), c("app.commandSearch"),
  ] },
  { title: "View", items: [
    c("view.zoom.fit"), c("view.zoom.selection"), c("view.zoom.in"), c("view.zoom.out"), "sep",
    c("view.mapview.topdown"), c("view.mapview.zslice"), c("view.mapview.cutaway"), c("view.render.relief"), "sep",
    c("view.layout.swap"), c("app.collapseRibbon"), "sep", n("fullscreen"),
  ] },
  { title: "Window", role: "windows", items: [
    n("minimize"), n("zoom"), "sep",
    c("view.windows.view3d"), c("view.windows.tools"), c("view.windows.hotbar"), c("view.windows.lens"),
    c("view.windows.sidebar"), c("view.layout.reset"), "sep", n("bringAllToFront"),
  ] },
  { title: "Help", role: "help", items: [c("app.help"), c("app.tour"), c("app.diagnostics")] },
];

/** Every command id the bar carries, in menu order. */
export function menuCommandIds(): CommandId[] {
  return MENU_BAR.flatMap(m => m.items.flatMap(e => (typeof e === "object" && "id" in e ? [e.id] : [])));
}

/**
 * `path: APP` commands deliberately left out of the bar. The bar is a map of the app, not of every
 * command (⌘K covers the rest): the Settings sub-tabs are one click inside Settings…, and Sound
 * Settings is a tab of the same dialog.
 */
export const MENU_BAR_EXCLUDED: Partial<Record<CommandId, string>> = {
  "app.sounds": "a tab of Settings…",
  "app.settings.layout": "a tab of Settings…",
  "app.settings.3d": "a tab of Settings…",
  "app.settings.editor": "a tab of Settings…",
  "app.settings.files": "a tab of Settings…",
  "app.settings.experiments": "a tab of Settings…",
};

/**
 * Toggles whose own label already says the state ("Collapse Ribbon" ↔ "Expand Ribbon"): a check mark
 * beside them would read backwards, so they're plain items and `setText` carries the state.
 */
const LABEL_STATE: ReadonlySet<CommandId> = new Set(["app.collapseRibbon"]);

/** A `CheckMenuItem` (a mark that follows `armed`) rather than a plain item. */
export function isCheckItem(id: CommandId): boolean {
  return meta(id).kind === "toggle" && !LABEL_STATE.has(id);
}

/** Kinds a menu item may have: `setting` / `picker` / `menu` commands need ribbon UI to mean anything. */
export const MENU_SAFE_KINDS = ["action", "toggle", "tool"] as const;

/** What the native responder is asked to do (`native_edit_action`). */
export type NativeEditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

/**
 * The six Edit items that must keep working in a focused text field. The custom menu replaced the
 * predefined Undo/Copy/… items, and in WKWebView those are the only reason ⌘C/⌘V/⌘Z/⌘A work in an
 * `<input>` — so with a field focused these forward to the native responder, and these items are
 * never greyed (a field's own Undo must work with nothing on the map's stack).
 */
export const TEXT_FORWARD: Partial<Record<CommandId, NativeEditAction>> = {
  "app.undo": "undo",
  "app.redo": "redo",
  "home.clipboard.cut": "cut",
  "home.clipboard.copy": "copy",
  "home.clipboard.paste": "paste",
  "selection.modify.selectAll": "selectAll",
};

/**
 * What runs with no world open (the splash has no ribbon, so no bindings): App builds a small binding
 * set for exactly these. The splash renders About, Settings, New World and the world browser, but
 * not Help, the Tour or Diagnostics, so those stay greyed until a world is open.
 */
export const SPLASH_SAFE: ReadonlySet<CommandId> = new Set<CommandId>([
  "app.new", "app.open", "app.download", "app.settings", "app.about", "app.close", "app.quit",
]);

/**
 * The menu command a keydown would also trigger through its accelerator, or `null`. The legacy keydown
 * handler stamps it (`noteKeyCommand`) so `runMenuCommand` can drop the menu's echo of the same key.
 * macOS only: the bar doesn't exist elsewhere.
 */
export function menuCommandForKey(e: KeyLike, mac: boolean): CommandId | null {
  if (!mac) return null;
  for (const id of menuCommandIds()) {
    // Only chords the legacy handler really runs: stamping ⌘Q (no JS handler) would make the dedupe
    // swallow the menu's own Quit.
    if (meta(id).handledBy !== "legacy-keydown") continue;
    for (const chord of meta(id).keys ?? []) {
      if (chordToAccelerator(chord) && matchChord(e, chord, true)) return id;
    }
  }
  return null;
}
