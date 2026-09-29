/**
 * ⌘K / Ctrl+K command search (UI redesign r3, 14.6; commands sub-plan §7).
 *
 * Every row is a registry command, shown with its ribbon path and keycap. ↵ runs, **Tab reveals**
 * (switches to its ribbon tab and flashes the button), Esc closes. The host (`Ribbon.tsx`) owns
 * what "run" and "reveal" mean — this component only picks a command.
 *
 * Keyboard model: focus stays in the search field; the list is an `aria-activedescendant` listbox,
 * so ↑/↓ never move DOM focus and Tab can be claimed for reveal without breaking traversal
 * anywhere else (the palette is the only thing on screen while it's open).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ribbon/icons";
import { Keycap } from "../ribbon/primitives";
import {
  ACCENT, BORDER, FONT, RADIUS, SURFACE, TEXT, TEXT_DIM, TEXT_DISABLED, TEXT_META, fieldStyle, lighten,
} from "../ribbon/tokens";
import { COMMAND_IDS, meta, type CommandFamily, type CommandId } from "./meta";
import { formatChord } from "./keys";
import { pushMru, rank, type SearchEntry } from "./search";
import { commandPath } from "./paths";
import type { CommandBinding } from "./types";

const MRU_KEY = "eden_cmd_mru";
const MAX_ROWS = 12;

/** Empty-query suggestions after the MRU (the mock's starter set, minus what isn't built yet). */
const STARTERS: CommandId[] = [
  "view.windows.view3d", "view.layout.swap", "sculpt.tools.rock",
  "home.selection.fill", "view.windows.tools", "app.save", "draw.tools.brush",
];

const FAMILY_HEX: Record<CommandFamily, string> = {
  primary: ACCENT.primary, warm: ACCENT.warm, selection: ACCENT.selection,
  clipboard: ACCENT.clipboard, violet: ACCENT.violet, danger: ACCENT.warm,
};

function loadMru(): CommandId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MRU_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is CommandId => typeof x === "string" && x in bindingsGuard) : [];
  } catch { return []; }
}
const bindingsGuard: Record<string, true> = Object.fromEntries(COMMAND_IDS.map(id => [id, true]));

/** Record a use — the host calls this on run and on reveal. */
export function recordCommandUse(id: CommandId) {
  try { localStorage.setItem(MRU_KEY, JSON.stringify(pushMru(loadMru(), id))); } catch { /* quota/private mode */ }
}

export interface CommandPaletteProps {
  bindings: Record<CommandId, CommandBinding>;
  /** Pixels from the top of the window (just under the ribbon). */
  top: number;
  onRun: (id: CommandId) => void;
  onReveal: (id: CommandId) => void;
  onClose: () => void;
}

export default function CommandPalette({ bindings, top, onRun, onReveal, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [mru] = useState(loadMru);

  const entries = useMemo<SearchEntry<CommandId>[]>(() => COMMAND_IDS
    .filter(id => id !== "app.commandSearch")
    .map(id => ({
      id,
      label: bindings[id].labelOverride ?? meta(id).label,
      path: commandPath(id),
      keywords: meta(id).keywords,
    })), [bindings]);

  const ids = useMemo<CommandId[]>(() => {
    if (query.trim()) return rank(query, entries, mru).slice(0, MAX_ROWS);
    const seen = new Set<CommandId>();
    return [...mru, ...STARTERS].filter(id => id !== "app.commandSearch" && !seen.has(id) && seen.add(id)).slice(0, MAX_ROWS);
  }, [query, entries, mru]);

  // A new query restarts the highlight at the top (derived-state pattern, no effect).
  const [prevQuery, setPrevQuery] = useState(query);
  if (prevQuery !== query) { setPrevQuery(query); setHi(0); }
  const cur = Math.min(hi, Math.max(0, ids.length - 1));

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  // Escape is capture-phase on window, like Popover's: nothing inside can swallow it.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  const act = (id: CommandId | undefined, how: "run" | "reveal") => {
    if (!id) return;
    const kind = meta(id).kind;
    // Settings and menus have nothing to run: ↵ reveals them too.
    if (how === "reveal" || kind === "setting" || kind === "menu") onReveal(id);
    else onRun(id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(Math.min(cur + 1, ids.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(Math.max(cur - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); act(ids[cur], "run"); }
    else if (e.key === "Tab") { e.preventDefault(); act(ids[cur], "reveal"); }
  };

  const activeId = ids[cur];

  return createPortal(
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,.18)" }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="Search commands" data-motion-pop
        style={{
          position: "absolute", top: top + 8, left: "50%", transform: "translateX(-50%)",
          width: 560, maxWidth: "calc(100vw - 24px)",
          background: SURFACE.popover, border: `1px solid ${BORDER.outline}`, borderRadius: RADIUS.lg,
          boxShadow: "0 12px 36px rgba(0,0,0,.55)", overflow: "hidden", color: TEXT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${BORDER.hairline}` }}>
          <Icon name="search" size={16} tone="default" />
          <input
            ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search commands…" aria-label="Search commands" spellCheck={false}
            role="combobox" aria-expanded aria-controls="cmdk-list"
            aria-activedescendant={activeId ? `cmdk-${activeId}` : undefined}
            style={{ ...fieldStyle, flex: 1, height: 28, fontSize: FONT.tab, textAlign: "left", color: TEXT, padding: "0 8px" }}
          />
          <span style={{ color: TEXT_META, fontSize: FONT.label, whiteSpace: "nowrap" }}>↵ run · Tab show</span>
        </div>
        <div ref={listRef} id="cmdk-list" role="listbox" aria-label="Commands"
          style={{ maxHeight: 420, overflowY: "auto", padding: 4 }}>
          {ids.length === 0 && (
            <div style={{ padding: "14px 10px", color: TEXT_META, fontSize: FONT.body }}>No matching commands</div>
          )}
          {ids.map((id, i) => {
            const m = meta(id);
            const b = bindings[id];
            const disabled = b.enabled !== true;
            const label = b.labelOverride ?? m.label;
            const chord = m.keys?.[0];
            const hue = m.family ? FAMILY_HEX[m.family] : undefined;
            return (
              <div
                key={id} id={`cmdk-${id}`} role="option" aria-selected={i === cur} aria-disabled={disabled || undefined}
                data-row={i} className="vx-row" data-cur={i === cur ? "" : undefined}
                title={disabled ? String(b.enabled) : (b.titleOverride ?? m.title)}
                onMouseMove={() => { if (i !== cur) setHi(i); }}
                onClick={() => act(id, "run")}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", cursor: "pointer",
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <span className="vx-ico" style={{ width: 18, display: "flex", justifyContent: "center", color: hue ? lighten(hue, 0.35) : TEXT_DIM }}>
                  {m.icon ? <Icon name={m.icon} size={15} tone="inherit" /> : null}
                </span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: FONT.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <Highlight text={label} query={query} />
                    {b.armed && <span style={{ color: TEXT_META, marginLeft: 6 }}>· on</span>}
                  </span>
                  <span style={{ fontSize: FONT.label, color: disabled ? TEXT_DISABLED : TEXT_META, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {disabled ? String(b.enabled) : commandPath(id)}
                  </span>
                </span>
                {chord && <Keycap text={formatChord(chord)} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Underline the first query token where it occurs in the label. */
function Highlight({ text, query }: { text: string; query: string }) {
  const tok = query.trim().split(/\s+/)[0]?.toLowerCase();
  const at = tok ? text.toLowerCase().indexOf(tok) : -1;
  if (!tok || at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<u>{text.slice(at, at + tok.length)}</u>{text.slice(at + tok.length)}</>;
}
