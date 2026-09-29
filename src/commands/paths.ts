import { groupPath } from "../ribbon/specs";
import { meta, type CommandId } from "./meta";
import type { WinId } from "../windows/windowGeometry";

const MENU_LABEL = { app: "Application menu", topbar: "Top bar", keyboard: "Keyboard" } as const;
const PANEL_LABEL: Partial<Record<WinId, string>> = {
  cutaway: "Cutaway panel", brushshape: "Brush shape panel", buildslot: "3D Build panel",
};

/** The breadcrumb ⌘K shows under a command: "Home › Selection", "Application menu". */
export function commandPath(id: CommandId): string {
  const p = meta(id).path;
  if ("tab" in p) return groupPath(p.tab, p.group);
  if ("panel" in p) return PANEL_LABEL[p.panel] ?? p.panel;
  return MENU_LABEL[p.menu];
}
