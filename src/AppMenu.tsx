/**
 * The application menu: a ~260 px command column plus a pane used only where it holds data or
 * controls (Open recent, Save toggles, Export, Properties, About). Other rows are plain commands
 * whose one-sentence description lives in their tooltip (`TIPS`).
 *
 * ⚠️ **The panel is a fixed size** (`MENU_W`×`MENU_H`). Hovering a pane-less row keeps the last
 * pane showing instead of blanking or resizing the panel.
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
const MENU_W = 600;
const MENU_H = 420;
const LIST_W = 260;

/** Rows that own a pane (data or controls). Every other row is a plain command with its sentence
 *  in a tooltip; hovering one leaves the last pane showing so the panel never resizes or blanks. */
const PANE_ROWS: readonly AppMenuRow[] = ["open", "save", "saveas", "export", "properties", "about"];
const TIPS: Partial<Record<AppMenuRow, string>> = {
  new: "Create a new world (Flat, Natural, Classic or TG2). Your open world isn't touched until you confirm.",
  download: "Browse and download worlds from the Eden servers (2.0+). Browsing uploads nothing.",
  upload: "Publish the last saved version of this world on the Eden server. Uploads can't be deleted.",
  settings: "Open Settings.",
  help: "Shortcuts and tool guides (Help, Guided tour and Diagnostics are in the Help window).",
  close: "Close this world and free its memory. You'll be asked first if there are unsaved changes.",
};

export default function AppMenu({
  initialRow, onClose, anchorTop,
}: {
  initialRow?: AppMenuRow;
  onClose: () => void;
  anchorTop: number;
}) {
  const { p } = useRibbon();
  const [row, setRow] = useState<AppMenuRow>(initialRow ?? "open");
  const [paneRow, setPaneRow] = useState<AppMenuRow>(PANE_ROWS.includes(initialRow ?? "open") ? (initialRow ?? "open") : "open");
  if (PANE_ROWS.includes(row) && row !== paneRow) setPaneRow(row);
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
      { kind: "row", id: "save", label: "Save", icon: "save", accel: `${MOD}S`, disabled: p.saving, onActivate: () => { if (!p.saving) { onClose(); if (p.sourcePath) p.saveWorld(p.sourcePath); else p.saveWorldAs(); } } },
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
            title={TIPS[r.id]} aria-current={row === r.id} tabIndex={row === r.id ? 0 : -1}
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
      <div data-pane style={{ flex: 1, padding: "14px 16px", overflowY: "auto", minWidth: 0 }}>
        <Pane row={paneRow} onClose={onClose} infoKey={infoKey} bumpInfo={() => setInfoKey(k => k + 1)} />
      </div>
    </div>
  );
}

// ── Pane chrome ───────────────────────────────────────────────────────────────

function PaneHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: FONT.tab, fontWeight: 600, color: TEXT_ARMED }}>{title}</h2>
      {sub && <div style={{ marginTop: 4, fontSize: FONT.body, color: TEXT_DIM, lineHeight: 1.5, maxWidth: "100%" }}>{sub}</div>}
    </div>
  );
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
  return <div style={{ fontSize: FONT.label, color: TEXT_LABEL, padding: "2px 0 0 18px", lineHeight: 1.5, maxWidth: "100%" }}>{text}</div>;
}

// ── The panes ─────────────────────────────────────────────────────────────────

function Pane({ row, onClose, infoKey, bumpInfo }: { row: AppMenuRow; onClose: () => void; infoKey: number; bumpInfo: () => void }) {
  const { p } = useRibbon();

  switch (row) {
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

    // ── Save ─────────────────────────────────────────────────────────────
    case "save":
      return (<>
        <PaneHead title="Save"
          sub={p.sourcePath
            ? <>Write your changes back to <code style={{ color: TEXT }}>{p.sourcePath}</code>.</>
            : "This world has never been written to a file. Saving asks where to put it."} />
        <div style={{ marginBottom: 12 }}>
          <CheckRow checked={p.saveCompressed} onChange={p.setSaveCompressed}
            label="Compressed (.zip container)"
            hint="Deflates the world inside a zip. Much smaller on disk. Either form opens fine, whatever the file is named." />
          <CheckRow checked={p.backupCompressed} onChange={p.setBackupCompressed}
            label="Compress the one-time backup"
            hint="The first save over a file keeps a full-size .bak until you delete it. This makes it a smaller .bak.zip, but slower." />
          {p.sourcePath && <BackupNote path={p.sourcePath} compressed={p.backupCompressed} />}
        </div>
        <div style={{ fontSize: FONT.label, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: "100%" }}>
          Only edited chunks are rewritten, and saves are crash-safe.
        </div>
        <Primary icon="save" label={p.saving ? "Saving…" : "Save Now"} busy={p.saving}
          disabled={p.saving}
          title={p.sourcePath ? `Save to ${p.sourcePath}` : "This world has no file yet. Choose where to save it."}
          onClick={() => { onClose(); if (p.sourcePath) p.saveWorld(p.sourcePath); else p.saveWorldAs(); }} />
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
        <div style={{ fontSize: FONT.label, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: "100%" }}>
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

    // ── About ────────────────────────────────────────────────────────────
    case "about":
      return (<>
        <AboutPanel version={p.appVersion} compact onOpenDiagnostics={() => { onClose(); p.setShowDiagnostics(true); }} />
      </>);

  }
}

function ExportRow({
  icon, title, desc, onExport, busy, disabled, badge,
}: {
  icon: IconName; title: string; desc: string; onExport: () => void;
  busy?: boolean; disabled?: boolean; badge?: ReactNode;
}) {
  // Export rows stay cards: unlike the explanatory panes these are *actions*, and each carries its
  // own button. The layout is column-major so a ~340px-wide pane never squeezes the description.
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
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: FONT.body, color: TEXT_DIM }}>Name</span>
      <TextField
        value={value} ariaLabel="World name" width={150}
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
