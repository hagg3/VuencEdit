import { groupPath } from "../ribbon/specs";
import { meta, type CommandId } from "./meta";

const MENU_LABEL = { app: "Application menu", topbar: "Top bar", keyboard: "Keyboard" } as const;

/** The breadcrumb ⌘K shows under a command: "Home › Selection", "Application menu". */
export function commandPath(id: CommandId): string {
  const p = meta(id).path;
  if ("tab" in p) return groupPath(p.tab, p.group);
  if ("bar" in p) return "Options bar";
  return MENU_LABEL[p.menu];
}
