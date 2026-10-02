/**
 * The Office-2007-style two-pane application menu, replacing the old VuencEdit ▾ and File ▾
 * dropdowns (and their inline `showRecentSub` / `showExportSub` accordions, which are now just
 * the right pane).
 *
 * Design rule for the right pane: **it is never empty.** Rows with nothing to preview — New,
 * Download, Upload, Help — explain what the command does and what the feature behind it can do,
 * so the pane teaches instead of sitting blank. Rows whose command is destructive or slow
 * (Save, Save As, Export) repeat the action as an explicit button in the pane, because clicking
 * the row itself is not obvious once the row also drives a preview.
 *
 * ⚠️ **The panel is a fixed width** (`MENU_W`), not `minWidth`-to-`maxWidth` elastic. Panes used
 * to be free to be as wide as their content, so the menu changed size as you moved down the
 * command column. The explanatory panes are therefore **plain text lists** (`TextList`), not the
 * two-column icon-card grid they used to be — a card grid needs width the fixed panel no longer
 * has, and none of that chrome carried information the text doesn't.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { spinnerStyle } from "./designTokens";
import { fmtBytes } from "./formatBytes";
import AboutPanel from "./panels/AboutPanel";
import WorldInfoPanel from "./panels/WorldInfoPanel";
import { Icon, type IconName } from "./ribbon/icons";
import { useRibbon } from "./ribbon/context";
import {
  ACCENT, BORDER, CUR_ICON, FONT, MOD, RADIUS, SHIFT, SURFACE, TEXT, TEXT_ARMED, TEXT_DANGER, TEXT_DIM, TEXT_LABEL,
  currentRow,
} from "./ribbon/tokens";
import { Check, Keycap, TextField } from "./ribbon/primitives";
import { v } from "./theme/cssVars";
import { DialogButton } from "./ui/Dialog";
import { SectionHeading } from "./ui/SettingRow";
import { timeAgo } from "./useRecentWorlds";

export type AppMenuRow =
  | "new" | "open" | "download"
  | "save" | "saveas"
  | "export" | "upload"
  | "properties"
  | "settings" | "help" | "about"
  | "close";

/** Fixed panel geometry — see the ⚠️ note in the file header. */
const MENU_W = 720;
const MENU_H = 540;
const LIST_W = 208;

export default function AppMenu({
  initialRow, onClose, anchorTop,
}: {
  initialRow?: AppMenuRow;
  onClose: () => void;
  anchorTop: number;
}) {
  const { p } = useRibbon();
  const [row, setRow] = useState<AppMenuRow>(initialRow ?? "open");
  const [infoKey, setInfoKey] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Escape closes this before App's global step-back sees it (capture phase + stopPropagation,
  // the same pattern the old File menu used).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const rows: ({ kind: "sep" } | { kind: "row"; id: AppMenuRow; label: string; icon: IconName; accel?: string; danger?: boolean; disabled?: boolean; onActivate?: () => void })[] =
    useMemo(() => [
      { kind: "row", id: "new", label: "New", icon: "new", accel: `${MOD}N`, onActivate: () => { onClose(); p.setShowNewWorld(true); } },
      { kind: "row", id: "open", label: "Open", icon: "open", accel: `${MOD}O`, onActivate: () => { onClose(); p.openFile(); } },
      { kind: "row", id: "download", label: "Download", icon: "download", onActivate: () => { onClose(); p.setShowWorldBrowser(true); } },
      { kind: "sep" },
      { kind: "row", id: "save", label: "Save", icon: "save", accel: `${MOD}S`, disabled: !p.sourcePath || p.saving, onActivate: () => { if (p.sourcePath && !p.saving) { onClose(); p.saveWorld(p.sourcePath); } } },
      { kind: "row", id: "saveas", label: "Save As", icon: "saveAs", accel: `${MOD}${SHIFT}S`, disabled: p.saving, onActivate: () => { if (!p.saving) { onClose(); p.saveWorldAs(); } } },
      { kind: "sep" },
      { kind: "row", id: "export", label: "Export", icon: "export" },
      { kind: "row", id: "upload", label: "Upload", icon: "upload", disabled: !p.world, onActivate: () => { onClose(); p.setShowUploadModal(true); } },
      { kind: "sep" },
      { kind: "row", id: "properties", label: "Properties", icon: "properties" },
      { kind: "sep" },
      { kind: "row", id: "settings", label: "Settings", icon: "settings", accel: `${MOD},`, onActivate: () => { onClose(); p.setShowSettings(true); } },
      { kind: "row", id: "help", label: "Help", icon: "help", accel: "?" },
      { kind: "row", id: "about", label: "About", icon: "about" },
      { kind: "sep" },
      { kind: "row", id: "close", label: "Close World", icon: "close", accel: `${MOD}W`, danger: true, disabled: !p.world, onActivate: () => { onClose(); p.closeWorld(); } },
    ], [p, onClose]);

  const rowIds = rows.filter(r => r.kind === "row").map(r => (r as { id: AppMenuRow }).id);

  function onListKeyDown(e: React.KeyboardEvent) {
    const i = rowIds.indexOf(row);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rowIds[(i + (e.key === "ArrowDown" ? 1 : rowIds.length - 1)) % rowIds.length];
      setRow(next);
      listRef.current?.querySelector<HTMLButtonElement>(`[data-row="${next}"]`)?.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      panelRef.current?.querySelector<HTMLElement>("[data-pane] button, [data-pane] a, [data-pane] input")?.focus();
    }
  }

  return (
    <div
      ref={panelRef}
      role="menu" aria-label="Application menu"
      // Slate popover material (palette A: menu = popover). It used to be the warm modal glass,
      // which read as a foreign object dropped over the cool ribbon.
      style={{
        background: SURFACE.popover,
        position: "fixed", top: anchorTop, left: 6, zIndex: 500,
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, ${v("pop-shadow")}`,
        borderRadius: RADIUS.lg,
        // Fixed, not elastic: the panel must not resize as the selected row changes.
        width: MENU_W, height: MENU_H,
        maxWidth: "96vw", maxHeight: `calc(100vh - ${anchorTop + 12}px)`,
        display: "flex", overflow: "hidden", color: TEXT,
      }}
    >
      {/* ── Left: command column ──────────────────────────────────────────── */}
      <div ref={listRef} onKeyDown={onListKeyDown}
        style={{
          width: LIST_W, flexShrink: 0, padding: "8px 6px", display: "flex", flexDirection: "column", gap: 1,
          background: SURFACE.body,
          borderRight: `1px solid ${BORDER.hairline}`, overflowY: "auto",
        }}>
        {rows.map((r, i) => r.kind === "sep" ? (
          <div key={`sep-${i}`} aria-hidden="true" style={{ height: 1, background: BORDER.hairline, margin: "5px 8px" }} />
        ) : (
          <button
            key={r.id} data-row={r.id} role="menuitem" type="button"
            aria-current={row === r.id} tabIndex={row === r.id ? 0 : -1}
            aria-disabled={r.disabled || undefined}
            onMouseEnter={() => setRow(r.id)}
            onFocus={() => setRow(r.id)}
            onClick={() => { setRow(r.id); r.onActivate?.(); }}
            style={{
              display: "flex", alignItems: "center", gap: 9, textAlign: "left",
              padding: "0 10px", height: 34, borderRadius: 5, border: "none", outline: "none",
              cursor: r.disabled ? "default" : "pointer", fontSize: FONT.tab,
              opacity: r.disabled ? 0.4 : 1,
              color: r.danger ? TEXT_DANGER : TEXT,
              // Current row = pushed in (Stage 14.2) — no accent fill or ring.
              ...(row === r.id ? currentRow() : { background: "transparent", boxShadow: "none" }),
              fontWeight: row === r.id ? 600 : 400,
            }}
          >
            <Icon name={r.icon} size={16} tone={r.danger ? "danger" : row === r.id ? "inherit" : "default"}
              style={!r.danger && row === r.id ? { color: CUR_ICON } : undefined} />
            <span style={{ flex: 1 }}>{r.label}</span>
            {r.accel && (
              <Keycap text={r.accel} small />
            )}
          </button>
        ))}
      </div>

      {/* ── Right: contextual pane ────────────────────────────────────────── */}
      <div data-pane style={{ flex: 1, padding: "16px 20px", overflowY: "auto", minWidth: 0 }}>
        <Pane row={row} onClose={onClose} infoKey={infoKey} bumpInfo={() => setInfoKey(k => k + 1)} />
      </div>
    </div>
  );
}

// ── Pane chrome ───────────────────────────────────────────────────────────────

function PaneHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: FONT.tab, fontWeight: 600, color: TEXT_ARMED }}>{title}</h2>
      {sub && <div style={{ marginTop: 4, fontSize: FONT.body, color: TEXT_DIM, lineHeight: 1.5, maxWidth: 620 }}>{sub}</div>}
    </div>
  );
}

/**
 * The explanatory panes' one presentation: a plain `term — definition` list.
 *
 * This replaced a two-column grid of icon cards. Under the fixed `MENU_W` those cards were both
 * too narrow to read and wider than the pane, and the icons were decorative — none of them named
 * anything the term didn't already say.
 */
function TextList({ items }: { items: [string, ReactNode][] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 14 }}>
      {items.map(([term, def]) => (
        <div key={term} style={{ fontSize: FONT.body, lineHeight: 1.55, color: TEXT_DIM }}>
          <span style={{ color: TEXT, fontWeight: 600 }}>{term}</span>
          <span style={{ color: TEXT_LABEL }}> — </span>
          {def}
        </div>
      ))}
    </div>
  );
}

/** Closing note under a pane's text list — the caveat, not the content. */
function PaneNote({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: FONT.label, color: TEXT_LABEL, marginBottom: 14, lineHeight: 1.5 }}>{children}</div>;
}

function Primary({ label, icon, onClick, disabled, busy, tone = "teal", title, neutral }: {
  label: string; icon: IconName; onClick: () => void; disabled?: boolean; busy?: boolean;
  tone?: "teal" | "danger"; title?: string; neutral?: boolean;
}) {
  return (
    <DialogButton variant={neutral ? "neutral" : tone === "danger" ? "danger" : "primary"}
      onClick={onClick} disabled={disabled} title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {busy ? <div style={spinnerStyle(14)} /> : <Icon name={icon} size={15} tone="inherit" />}
      {label}
    </DialogButton>
  );
}

function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div style={{ padding: "5px 0" }}>
      <Check checked={checked} onChange={onChange} hint={hint} label={label} />
    </div>
  );
}

interface BackupStatus { existing_name: string | null; existing_bytes: number; source_bytes: number }

/** 18.8 (audit S-1): a plain `.bak` is a world-sized copy kept beside the file forever, so the Save
 *  pane says how big the backup is (or will be) instead of the default changing under the user. */
function BackupNote({ path, compressed }: { path: string; compressed: boolean }) {
  const [st, setSt] = useState<BackupStatus | null>(null);
  useEffect(() => {
    let live = true;
    invoke<BackupStatus>("backup_status", { path, backupCompressed: compressed })
      .then(s => { if (live) setSt(s); }, () => { if (live) setSt(null); });
    return () => { live = false; };
  }, [path, compressed]);
  if (!st) return null;
  let text: ReactNode = null;
  if (st.existing_name) {
    text = <>Backup already kept: <code style={{ color: TEXT }}>{st.existing_name}</code> ({fmtBytes(st.existing_bytes)}).
      Later saves leave it alone. If you delete it, the next save makes a fresh one.</>;
  } else if (st.source_bytes > 0) {
    text = compressed
      ? <>This save first zips the current file ({fmtBytes(st.source_bytes)}) to <code style={{ color: TEXT }}>.bak.zip</code>, kept until you delete it.</>
      : <>This save first copies the current file to <code style={{ color: TEXT }}>.bak</code>: {fmtBytes(st.source_bytes)} more on disk, kept until you delete it.</>;
  }
  if (!text) return null;
  return <div style={{ fontSize: FONT.label, color: TEXT_LABEL, padding: "2px 0 0 18px", lineHeight: 1.5, maxWidth: 620 }}>{text}</div>;
}

// ── The panes ─────────────────────────────────────────────────────────────────

function Pane({ row, onClose, infoKey, bumpInfo }: { row: AppMenuRow; onClose: () => void; infoKey: number; bumpInfo: () => void }) {
  const { p } = useRibbon();

  switch (row) {
    // ── New ──────────────────────────────────────────────────────────────
    case "new":
      return (<>
        <PaneHead title="New World"
          sub="Create a new world." />
        <TextList items={[
          ["Flat", "A flat slab. Best if you'll build everything yourself."],
          ["Natural", "Rolling terrain with biomes, coasts and mountains."],
          ["Classic", "The original Eden terrain generator (v1.7)."],
          ["TG2", "The Eden 2.0 generator, with nine terrain types."],
        ]} />
        <PaneNote>
          New worlds are 256z unless you pick 64z. Your open world isn't touched until you confirm.
        </PaneNote>
        <Primary icon="new" label="New World…" onClick={() => { onClose(); p.setShowNewWorld(true); }} />
      </>);

    // ── Open ─────────────────────────────────────────────────────────────
    case "open":
      return (<>
        <PaneHead title="Open World"
          sub="Open a .eden or .zip world." />
        <SectionHeading first>Recent worlds</SectionHeading>
        {p.recentWorlds.length === 0 ? (
          <div style={{ color: TEXT_DIM, fontSize: FONT.body, padding: "10px 0" }}>
            No recent worlds yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 16 }}>
            {p.recentWorlds.map(r => (
              <button key={r.path} type="button" title={r.path} className="vx-row"
                onClick={() => { onClose(); p.openFileAt(r.path); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "0 10px", height: 34,
                  background: "none", border: "none", outline: "none", cursor: "pointer",
                  textAlign: "left", color: TEXT, fontSize: FONT.tab,
                }}>
                <Icon name="open" size={15} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: FONT.label, color: TEXT_LABEL }}>{timeAgo(r.timestamp)}</span>
              </button>
            ))}
          </div>
        )}
        <Primary icon="open" label="Browse for a file…" onClick={() => { onClose(); p.openFile(); }} />
      </>);

    // ── Download ─────────────────────────────────────────────────────────
    case "download":
      return (<>
        <PaneHead title="Download a World"
          sub="Download worlds from the Eden servers (current 2.2+ and legacy 2.0–2.1)." />
        <TextList items={[
          ["Quality sort", "Ranks hand-built worlds above test uploads (experimental)."],
          ["Date filters", "Find worlds from a given time."],
          ["Hide junk", "Hides empty and placeholder uploads (experimental)."],
        ]} />
        <PaneNote>
          Connections use plain HTTP. Browsing doesn't upload anything.
        </PaneNote>
        <Primary icon="download" label="Browse Online Worlds…" onClick={() => { onClose(); p.setShowWorldBrowser(true); }} />
      </>);

    // ── Save ─────────────────────────────────────────────────────────────
    case "save":
      return (<>
        <PaneHead title="Save"
          sub={p.sourcePath
            ? <>Write your changes back to <code style={{ color: TEXT }}>{p.sourcePath}</code>.</>
            : "This world has never been written to a file. Use Save As to choose a location."} />
        <div style={{ marginBottom: 12 }}>
          <CheckRow checked={p.saveCompressed} onChange={p.setSaveCompressed}
            label="Compressed (.zip container)"
            hint="Deflates the world inside a zip. Much smaller on disk. Either form opens fine, whatever the file is named." />
          <CheckRow checked={p.backupCompressed} onChange={p.setBackupCompressed}
            label="Compress the one-time backup"
            hint="The first save over a file keeps a full-size .bak until you delete it. This makes it a smaller .bak.zip, but slower." />
          {p.sourcePath && <BackupNote path={p.sourcePath} compressed={p.backupCompressed} />}
        </div>
        <div style={{ fontSize: FONT.label, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: 620 }}>
          Only edited chunks are rewritten, and saves are crash-safe.
        </div>
        <Primary icon="save" label={p.saving ? "Saving…" : "Save Now"} busy={p.saving}
          disabled={!p.sourcePath || p.saving}
          title={p.sourcePath ? `Save to ${p.sourcePath}` : "This world has no file yet. Use Save As."}
          onClick={() => { if (p.sourcePath) { onClose(); p.saveWorld(p.sourcePath); } }} />
      </>);

    // ── Save As ──────────────────────────────────────────────────────────
    case "saveas":
      return (<>
        <PaneHead title="Save As"
          sub="Write the world to a new file and continue editing that copy." />
        <div style={{ marginBottom: 12 }}>
          <CheckRow checked={p.saveCompressed} onChange={p.setSaveCompressed}
            label="Compressed (.zip container)"
            hint="The file extension is set to match." />
          <CheckRow checked={p.backupCompressed} onChange={p.setBackupCompressed}
            label="Compress the one-time backup"
            hint="Only applies if you save over a file that already exists. A plain .bak is the full size of that file." />
        </div>
        <div style={{ fontSize: FONT.label, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: 620 }}>
          You'll be asked before a file is overwritten. Later saves go to the new file.
        </div>
        <Primary icon="saveAs" label="Choose Location & Save…" disabled={p.saving}
          onClick={() => { onClose(); p.saveWorldAs(); }} />
      </>);

    // ── Export ───────────────────────────────────────────────────────────
    case "export":
      return (<>
        <PaneHead title="Export"
          sub="Exports never change your world." />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <ExportRow icon="fullmap" title="PNG image" busy={p.longOpKind === "png"}
            desc="A top-down image of the whole map, one pixel per block."
            onExport={() => { onClose(); p.exportPng(); }} />
        </div>
      </>);

    // ── Upload ───────────────────────────────────────────────────────────
    case "upload":
      return (<>
        <PaneHead title="Upload"
          sub="Publish this world on the Eden server for others to download." />
        <TextList items={[
          ["What gets sent", "The saved world file, compressed, plus your preview image. Unsaved edits aren't included. Your local file is not modified and nothing else about your machine is transmitted."],
          ["Name and description", "The listing name is separate from the world's own name (top bar)."],
          ["Save first", `Uploading sends the last saved version. Save first (${MOD}S) to include recent edits.`],
          ["Finding it again", "Uploads can't be deleted, so treat them as permanent."],
        ]} />
        <Primary icon="upload" label="Upload This World…" disabled={!p.world}
          onClick={() => { onClose(); p.setShowUploadModal(true); }} />
      </>);

    // ── Properties ───────────────────────────────────────────────────────
    case "properties":
      return (<>
        <PaneHead title="World Properties" sub="Details from the world file." />
        {p.world ? (<>
          <RenameField onRenamed={bumpInfo} />
          <WorldInfoPanel refreshKey={infoKey} />
        </>) : (
          <div style={{ color: TEXT_DIM, fontSize: FONT.body }}>No world is open.</div>
        )}
      </>);

    // ── Settings ─────────────────────────────────────────────────────────
    case "settings":
      return (<>
        <PaneHead title="Settings"
          sub="Quick view toggles. Open Settings for the rest." />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 16, maxWidth: 620 }}>
          <CheckRow label="3D view" checked={p.view3dWindowOpen} onChange={() => p.onToggle3dWindow()}
            hint="Floating 3D view. Tab swaps it with the map." />
          <CheckRow label="Docked sidebar" checked={p.sidebarOpen} onChange={() => p.onToggleSidebar()}
            hint="Inspector, prefab library and undo history." />
        </div>
        <Primary icon="settings" label="Open Settings…" onClick={() => { onClose(); p.setShowSettings(true); }} />
      </>);

    // ── Help ─────────────────────────────────────────────────────────────
    case "help":
      return (<>
        <PaneHead title="Help"
          sub="Shortcuts and tool guides. The basics:" />
        <TextList items={[
          ["Getting around", <>Middle-drag pans from any tool; <Kbd>Space</Kbd> holds pan temporarily. <Kbd>Home</Kbd> fits the whole map, <Kbd>{MOD}±</Kbd> zooms, <Kbd>{MOD}{SHIFT}0</Kbd> zooms to the selection.</>],
          ["Selecting", <><Kbd>S</Kbd> rectangle, <Kbd>W</Kbd> magic wand, <Kbd>K</Kbd> lasso, <Kbd>J</Kbd> polygon.</>],
          ["Drawing", <><Kbd>P</Kbd> pen, <Kbd>B</Kbd> brush, <Kbd>L</Kbd> line, <Kbd>R</Kbd> rectangle, <Kbd>E</Kbd> ellipse, <Kbd>G</Kbd> polygon, <Kbd>I</Kbd> eyedropper. Digits <Kbd>1</Kbd>–<Kbd>5</Kbd> arm pinned blocks, <Kbd>6</Kbd>–<Kbd>0</Kbd> recent ones.</>],
          ["Sculpting", <><Kbd>[</Kbd> / <Kbd>]</Kbd> change radius, with <Kbd>{SHIFT}</Kbd> for strength. Escape mid-stroke reverts the whole stroke as one undo step.</>],
          ["Undo", <><Kbd>{MOD}Z</Kbd> / <Kbd>{MOD}{SHIFT}Z</Kbd>. The sidebar's History tab lists every step.</>],
          ["Escape", "Steps back one level per press (paste, shape, selection…)."],
        ]} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Primary icon="help" label="Open Help" onClick={() => { onClose(); p.setShowHelp(true); }} />
          <Primary neutral icon="sparkle" label="Guided tour" onClick={() => { onClose(); p.startTour(); }} />
          <Primary neutral icon="about" label="Open Diagnostics…" onClick={() => { onClose(); p.setShowDiagnostics(true); }} />
        </div>
      </>);

    // ── About ────────────────────────────────────────────────────────────
    case "about":
      return (<>
        <AboutPanel version={p.appVersion} compact onOpenDiagnostics={() => { onClose(); p.setShowDiagnostics(true); }} />
      </>);

    // ── Close World ──────────────────────────────────────────────────────
    case "close":
      return (<>
        <PaneHead title="Close World"
          sub="Close this world and free its memory." />
        <div style={{ fontSize: FONT.body, color: TEXT_DIM, lineHeight: 1.6, maxWidth: 620, marginBottom: 16 }}>
          You'll be asked first if there are unsaved changes. Autosave is kept, so an accidental close can be recovered.
        </div>
        <Primary icon="close" tone="danger" label="Close World" disabled={!p.world}
          onClick={() => { onClose(); p.closeWorld(); }} />
      </>);
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return <Keycap text={children} small />;
}

function ExportRow({
  icon, title, desc, onExport, busy, disabled, badge,
}: {
  icon: IconName; title: string; desc: string; onExport: () => void;
  busy?: boolean; disabled?: boolean; badge?: ReactNode;
}) {
  // Export rows stay cards: unlike the explanatory panes these are *actions*, and each carries its
  // own button. The layout is column-major so a 476px-wide pane never squeezes the description.
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 7, padding: "10px 12px", borderRadius: RADIUS.lg,
      background: SURFACE.well, boxShadow: `inset 0 0 0 1px ${BORDER.hairline}`,
      opacity: disabled ? 0.5 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Icon name={icon} size={16} />
        <div style={{ fontSize: FONT.body, fontWeight: 600, color: TEXT, display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          {title}{badge}
        </div>
        <Primary icon="export" label={busy ? "Exporting…" : "Export"} busy={busy}
          disabled={disabled || busy} onClick={onExport} title={`Export ${title}`} />
      </div>
      <div style={{ fontSize: FONT.label, color: TEXT_DIM, lineHeight: 1.45 }}>{desc}</div>
    </div>
  );
}

/** Inline rename on the Properties pane — the same command the world pill exposes. */
function RenameField({ onRenamed }: { onRenamed: () => void }) {
  const { p } = useRibbon();
  const [value, setValue] = useState(p.world?.name ?? "");
  const [hint, setHint] = useState(false);
  const allowed = /[A-Za-z0-9' ]/;
  const dirty = value.trim() !== (p.world?.name ?? "");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: FONT.body, color: TEXT_DIM, width: 52 }}>Name</span>
      <TextField
        value={value} ariaLabel="World name" width={300}
        title="Letters, numbers, spaces and apostrophes (max 32)"
        onChange={raw => {
          const clean = raw.split("").filter(c => allowed.test(c)).join("").slice(0, 32);
          setHint(clean !== raw);
          setValue(clean);
        }}
        onKeyDown={e => { if (e.key === "Enter" && dirty) { p.onRenameBlur(value.trim()); onRenamed(); } }}
      />
      <Primary neutral icon="save" label="Rename" disabled={!dirty}
        onClick={() => { p.onRenameBlur(value.trim()); onRenamed(); }} />
      {hint && <span style={{ color: ACCENT.warm, fontSize: FONT.label }}>letters, numbers, spaces and ’ only</span>}
    </div>
  );
}
