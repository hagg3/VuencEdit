/**
 * The macOS menu bar (34.1, `TEST WORLDS/macos-menu-bar-plan-2026-11-10.md`), built in TypeScript from
 * the command registry with Tauri's JS menu API (`@tauri-apps/api/menu`): labels and accelerators come
 * straight from `meta.ts`, each item's `action` runs in-process, and `setEnabled` / `setChecked` /
 * `setText` keep it current. Rust can't read `meta.ts`, so a Rust-built menu would need codegen or a
 * hand-copied list — the drift the registry exists to prevent.
 *
 * This file owns only the Tauri plumbing. Layout is `commands/menuBar.ts`; what's enabled and what a
 * click does is `commands/menuRouting.ts` (both pure, tested). **macOS only**: the caller installs it
 * behind `IS_MAC`; Windows is a frameless ribbon app and Linux has no menu today.
 *
 * Not React state, deliberately: the ribbon publishes its bindings on every render, and a `setState`
 * on that path would re-render it again in a loop. `sync()` is a microtask-coalesced diff instead.
 */
import {
  CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import { meta, type CommandId } from "./commands/meta";
import { firstAccelerator } from "./commands/keys";
import { MENU_BAR, isCheckItem, type MenuEntry, type NativeItem } from "./commands/menuBar";
import { menuItemState, type MenuGate, type MenuItemState } from "./commands/menuRouting";
import type { CommandBinding } from "./commands/types";

export interface RecentEntry { path: string; name: string }

/** What the menu reads from App. Every call is cheap and side-effect free except `run` / `openRecent`. */
export interface MenuHost {
  gate(): MenuGate;
  binding(id: CommandId): CommandBinding | undefined;
  /** A menu click or accelerator (App's `runMenuCommand` applies the gates). */
  run(id: CommandId): void;
  openRecent(path: string): void;
}

export interface NativeMenu {
  /** Re-read bindings + gate and push only what changed. Safe to call every render. */
  sync(): void;
  setRecent(recent: readonly RecentEntry[]): void;
  dispose(): void;
}

const PREDEFINED: Record<NativeItem, PredefinedMenuItemOptions["item"]> = {
  services: "Services", hide: "Hide", hideOthers: "HideOthers", showAll: "ShowAll",
  fullscreen: "Fullscreen", minimize: "Minimize", zoom: "Maximize", bringAllToFront: "BringAllToFront",
};

export function createNativeMenu(host: MenuHost): NativeMenu {
  let disposed = false;
  let built = false;
  let pending = false;
  let appMenu: Menu | null = null;
  let recentSub: Submenu | null = null;
  let recentEnabled = true;
  let recent: readonly RecentEntry[] = [];
  let recentKey: string | null = null;
  let recentChain: Promise<void> = Promise.resolve();
  const items = new Map<CommandId, MenuItem | CheckMenuItem>();
  /** What was last sent per item, so a render that changed nothing makes no IPC call. */
  const last = new Map<CommandId, MenuItemState>();
  let warned = false;
  const warn = (e: unknown) => { if (!warned) { warned = true; console.warn("[menu] update failed:", e); } };

  function schedule() {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(flush);
  }

  function flush() {
    pending = false;
    if (!built || disposed) return;
    const gate = host.gate();
    for (const [id, item] of items) {
      const st = menuItemState(id, gate, host.binding(id));
      const prev = last.get(id);
      if (!prev || prev.enabled !== st.enabled) item.setEnabled(st.enabled).catch(warn);
      if (!prev || prev.text !== st.text) item.setText(st.text).catch(warn);
      if (st.checked !== null && (!prev || prev.checked !== st.checked)) {
        void (item as CheckMenuItem).setChecked(st.checked).catch(warn);
      }
      last.set(id, st);
    }
    const open = gate.blocked === "none";
    if (recentSub && open !== recentEnabled) { recentEnabled = open; recentSub.setEnabled(open).catch(warn); }
  }

  async function makeItem(id: CommandId): Promise<MenuItem | CheckMenuItem> {
    const m = meta(id);
    const st = menuItemState(id, host.gate(), host.binding(id));
    const base = {
      id, text: st.text, enabled: st.enabled,
      accelerator: firstAccelerator(m.keys) ?? undefined,
      action: () => {
        host.run(id);
        // muda flips a CheckMenuItem's mark itself on click; forget what we sent so the next sync puts
        // it back in step with `armed` (clicking the already-checked "Top-down" must stay checked).
        last.delete(id);
        schedule();
      },
    };
    const item = isCheckItem(id)
      ? await CheckMenuItem.new({ ...base, checked: !!st.checked })
      : await MenuItem.new(base);
    items.set(id, item);
    last.set(id, st);
    return item;
  }

  async function makeEntry(e: MenuEntry): Promise<MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu> {
    if (e === "sep") return PredefinedMenuItem.new({ item: "Separator" });
    if ("id" in e) return makeItem(e.id);
    if ("native" in e) return PredefinedMenuItem.new({ item: PREDEFINED[e.native] });
    recentSub = await Submenu.new({ text: "Open Recent", items: [] });
    return recentSub;
  }

  function syncRecent() {
    recentChain = recentChain.then(async () => {
      const sub = recentSub;
      if (!sub || !built || disposed) return;
      const key = JSON.stringify(recent.map(r => [r.path, r.name]));
      if (key === recentKey) return;
      recentKey = key;
      for (const old of await sub.items()) await sub.remove(old);
      if (recent.length === 0) {
        await sub.append(await MenuItem.new({ text: "No Recent Worlds", enabled: false }));
        return;
      }
      const made: MenuItem[] = [];
      for (let i = 0; i < recent.length; i++) {
        const r = recent[i];
        made.push(await MenuItem.new({
          id: `recent:${i}`, text: r.name || r.path.split(/[\\/]/).pop() || r.path,
          action: () => host.openRecent(r.path),
        }));
      }
      await sub.append(made);
    }).catch(warn);
  }

  async function build() {
    const subs: Submenu[] = [];
    let windows: Submenu | null = null;
    let help: Submenu | null = null;
    for (const spec of MENU_BAR) {
      const entries: Awaited<ReturnType<typeof makeEntry>>[] = [];
      for (const e of spec.items) entries.push(await makeEntry(e));
      const sub = await Submenu.new({ text: spec.title, items: entries });
      if (spec.role === "windows") windows = sub;
      if (spec.role === "help") help = sub;
      subs.push(sub);
    }
    const menu = await Menu.new({ items: subs });
    if (disposed) { await menu.close().catch(() => {}); return; }
    appMenu = menu;
    // The stock menu stays up until this resolves (a few hundred ms after React mounts). It is left on
    // in Rust (`enable_macos_default_menu`) so the app still has Quit/Hide if the frontend never loads.
    await menu.setAsAppMenu();
    // AppKit appends the window list to Window, and Help gets the system search field, which searches
    // every item in the bar for free.
    await windows?.setAsWindowsMenuForNSApp();
    await help?.setAsHelpMenuForNSApp();
    built = true;
    syncRecent();
    flush();
  }

  build().catch(e => console.warn("[menu] build failed:", e));

  return {
    sync: schedule,
    setRecent(r) { recent = r; syncRecent(); },
    dispose() {
      disposed = true;
      void appMenu?.close().catch(() => {});
    },
  };
}
