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
import { EDEN_TEAL_READABLE, expBadge, glassPanel, spinnerStyle } from "./designTokens";
import AboutPanel from "./panels/AboutPanel";
import WorldInfoPanel from "./panels/WorldInfoPanel";
import { Icon, type IconName } from "./ribbon/icons";
import { useRibbon } from "./ribbon/context";
import {
  ACCENT, BORDER, RADIUS, SURFACE, TEXT, TEXT_DIM, TEXT_LABEL, btnBase, hexToRgbTriplet,
} from "./ribbon/tokens";
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
const ACCENT_RGB = hexToRgbTriplet(ACCENT.primary);

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

  const rows: ({ kind: "sep" } | { kind: "row"; id: AppMenuRow; label: string; icon: IconName; danger?: boolean; disabled?: boolean; onActivate?: () => void })[] =
    useMemo(() => [
      { kind: "row", id: "new", label: "New", icon: "new", onActivate: () => { onClose(); p.setShowNewWorld(true); } },
      { kind: "row", id: "open", label: "Open", icon: "open", onActivate: () => { onClose(); p.openFile(); } },
      { kind: "row", id: "download", label: "Download", icon: "download", onActivate: () => { onClose(); p.setShowWorldBrowser(true); } },
      { kind: "sep" },
      { kind: "row", id: "save", label: "Save", icon: "save", disabled: !p.sourcePath || p.saving, onActivate: () => { if (p.sourcePath && !p.saving) { onClose(); p.saveWorld(p.sourcePath); } } },
      { kind: "row", id: "saveas", label: "Save As", icon: "saveAs", disabled: p.saving, onActivate: () => { if (!p.saving) { onClose(); p.saveWorldAs(); } } },
      { kind: "sep" },
      { kind: "row", id: "export", label: "Export", icon: "export" },
      { kind: "row", id: "upload", label: "Upload", icon: "upload", disabled: !p.world, onActivate: () => { onClose(); p.setShowUploadModal(true); } },
      { kind: "sep" },
      { kind: "row", id: "properties", label: "Properties", icon: "properties" },
      { kind: "sep" },
      { kind: "row", id: "settings", label: "Settings", icon: "settings", onActivate: () => { onClose(); p.setShowSettings(true); } },
      { kind: "row", id: "help", label: "Help", icon: "help" },
      { kind: "row", id: "about", label: "About", icon: "about" },
      { kind: "sep" },
      { kind: "row", id: "close", label: "Close World", icon: "close", danger: true, disabled: !p.world, onActivate: () => { onClose(); p.closeWorld(); } },
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
      style={glassPanel({
        position: "fixed", top: anchorTop, left: 6, zIndex: 500,
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 20px 50px rgba(0,0,0,.55)`,
        borderRadius: RADIUS.lg,
        // Fixed, not elastic: the panel must not resize as the selected row changes.
        width: MENU_W, height: MENU_H,
        maxWidth: "96vw", maxHeight: `calc(100vh - ${anchorTop + 12}px)`,
        display: "flex", overflow: "hidden", color: TEXT,
      })}
    >
      {/* ── Left: command column ──────────────────────────────────────────── */}
      <div ref={listRef} onKeyDown={onListKeyDown}
        style={{
          width: LIST_W, flexShrink: 0, padding: "8px 6px", display: "flex", flexDirection: "column", gap: 1,
          background: "linear-gradient(180deg, rgba(255,255,255,.045) 0%, rgba(255,255,255,.015) 100%)",
          borderRight: `1px solid ${BORDER.hairline}`, overflowY: "auto",
        }}>
        {rows.map((r, i) => r.kind === "sep" ? (
          <div key={`sep-${i}`} aria-hidden="true" style={{ height: 1, background: "rgba(255,255,255,.09)", margin: "5px 8px" }} />
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
              cursor: r.disabled ? "default" : "pointer", fontSize: 14,
              opacity: r.disabled ? 0.4 : 1,
              color: r.danger ? "#e39c99" : row === r.id ? "#ffffff" : "#d6dcde",
              background: row === r.id
                ? `linear-gradient(180deg, rgba(${ACCENT_RGB},.38) 0%, rgba(${ACCENT_RGB},.16) 100%)`
                : "transparent",
              boxShadow: row === r.id ? `inset 0 0 0 1px rgba(${ACCENT_RGB},.7)` : "none",
              fontWeight: row === r.id ? 600 : 400,
            }}
          >
            <Icon name={r.icon} size={16} tone={r.danger ? "danger" : "default"} />
            {r.label}
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
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: EDEN_TEAL_READABLE }}>{title}</h2>
      {sub && <div style={{ marginTop: 4, fontSize: 12.5, color: TEXT_DIM, lineHeight: 1.5, maxWidth: 620 }}>{sub}</div>}
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
        <div key={term} style={{ fontSize: 12, lineHeight: 1.55, color: TEXT_DIM }}>
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
  return <div style={{ fontSize: 11.5, color: TEXT_LABEL, marginBottom: 14, lineHeight: 1.5 }}>{children}</div>;
}

function Primary({ label, icon, onClick, disabled, busy, tone = "teal", title }: {
  label: string; icon: IconName; onClick: () => void; disabled?: boolean; busy?: boolean;
  tone?: "teal" | "danger"; title?: string;
}) {
  const accent = tone === "danger" ? "#ef4444" : EDEN_TEAL_READABLE;
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      style={btnBase({
        display: "inline-flex", alignItems: "center", gap: 8, padding: "0 16px", height: 32,
        fontSize: 13, fontWeight: 600, borderRadius: 6, color: disabled ? "#7a8488" : TEXT,
        background: disabled
          ? "rgba(255,255,255,.04)"
          : `linear-gradient(180deg, rgba(${tone === "danger" ? "239,68,68" : "0,164,173"},.42), rgba(${tone === "danger" ? "239,68,68" : "0,164,173"},.16))`,
        boxShadow: `inset 0 0 0 1px ${disabled ? "rgba(255,255,255,.10)" : accent}`,
        cursor: disabled ? "not-allowed" : "pointer",
      })}>
      {busy ? <div style={spinnerStyle(14)} /> : <Icon name={icon} size={15} tone="inherit" />}
      {label}
    </button>
  );
}

function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer", padding: "5px 0" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ accentColor: EDEN_TEAL_READABLE, marginTop: 2 }} />
      <span>
        <span style={{ fontSize: 12.5, color: TEXT }}>{label}</span>
        <span style={{ display: "block", fontSize: 11.5, color: TEXT_DIM, lineHeight: 1.45 }}>{hint}</span>
      </span>
    </label>
  );
}

// ── The panes ─────────────────────────────────────────────────────────────────

function Pane({ row, onClose, infoKey, bumpInfo }: { row: AppMenuRow; onClose: () => void; infoKey: number; bumpInfo: () => void }) {
  const { p } = useRibbon();

  switch (row) {
    // ── New ──────────────────────────────────────────────────────────────
    case "new":
      return (<>
        <PaneHead title="New World"
          sub="Generate a fresh world. Pick a size and a generator in the dialog. Every generator writes a complete, playable world you can edit immediately." />
        <TextList items={[
          ["Flat", "Uniform slab at a chosen height. The blank canvas: fastest to make, and the right starting point when you intend to build everything yourself."],
          ["Natural", "Customizable terrain generation, such as rolling terrain with coasts and mountain ranges. Six octaves of fBm plus ridged noise for the heightmap, then per-column biomes."],
          ["Classic", <>The older v1.7 era <code>TerrainGenerator</code>: seeded Ken-Perlin noise, ten height octaves and 3D-noise caves.</>],
          ["Terrain Gen 2", <>The 2.0+ era <code>TerrainGen2</code> — nine terrain types with bidirectional biome-seam blending, plus pyramid, volcano and sky-island structures.</>],
        ]} />
        <PaneNote>
          Worlds are created in the <strong>New Dawn 256z</strong> format (256 blocks tall) unless you
          choose the legacy 64z size. Creating a world does not touch the one you have open until you confirm.
        </PaneNote>
        <Primary icon="new" label="New World…" onClick={() => { onClose(); p.setShowNewWorld(true); }} />
      </>);

    // ── Open ─────────────────────────────────────────────────────────────
    case "open":
      return (<>
        <PaneHead title="Open World"
          sub="Open a .eden file, compressed and/or zipped, or otherwise. Format is detected from the file's magic bytes, not its extension." />
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", color: TEXT_LABEL, textTransform: "uppercase", marginBottom: 7 }}>
          Recent worlds
        </div>
        {p.recentWorlds.length === 0 ? (
          <div style={{ color: TEXT_DIM, fontSize: 12.5, padding: "10px 0" }}>
            No recent worlds yet — anything you open or save shows up here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 16 }}>
            {p.recentWorlds.map(r => (
              <button key={r.path} type="button" title={r.path}
                onClick={() => { onClose(); p.openFileAt(r.path); }}
                style={btnBase({
                  display: "flex", alignItems: "center", gap: 10, padding: "0 10px", height: 34,
                  background: "none", boxShadow: "none", textAlign: "left", color: TEXT,
                })}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,.07)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                <Icon name="open" size={15} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{r.name}</span>
                <span style={{ fontSize: 11, color: TEXT_LABEL }}>{timeAgo(r.timestamp)}</span>
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
          sub="Browse worlds published to the Eden community servers and pull one straight into the editor. Both the current (2.2+) and the legacy (2.0-2.1) servers are supported." />
        <TextList items={[
          ["Quality sort", "Experimental feature which ranks results by a heuristic over size, chunk count and name, so hand-built worlds surface ahead of the generated test uploads that dominate the raw listing."],
          ["Date filters", "Useful for finding a world you saw recently, or for archaeology on the early days of the server."],
          ["Hide junk", "Experimental feature which filters out empty, tiny and obviously-placeholder uploads in one click."],
        ]} />
        <PaneNote>
          Connections use plain HTTP: the server's TLS endpoint is not usable. Nothing is uploaded
          while browsing.
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
            hint="Deflates the world inside a zip. Much smaller on disk and what the game expects for uploads; the editor detects either form on open, whatever the file is named." />
          <CheckRow checked={p.backupCompressed} onChange={p.setBackupCompressed}
            label="Compress the one-time backup"
            hint="The first save over an existing file keeps its previous bytes as a .bak. With this on, that backup is deflated to .bak.zip instead of a plain copy." />
        </div>
        <div style={{ fontSize: 11.5, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: 620 }}>
          Saving tries an incremental in-place write first. Only the chunks you actually edited are
          rewritten, through a committed write-ahead log that is rolled forward if the app is killed
          mid-save. If that isn't safe (the file changed underneath you, or too much is dirty) it
          falls back to a full atomic temp-then-rename write.
        </div>
        <Primary icon="save" label={p.saving ? "Saving…" : "Save Now"} busy={p.saving}
          disabled={!p.sourcePath || p.saving}
          title={p.sourcePath ? `Save to ${p.sourcePath}` : "Use Save As — this world has no file yet"}
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
            hint="Save As corrects a mismatched .eden/.zip extension for you, so the name always matches the container you picked." />
          <CheckRow checked={p.backupCompressed} onChange={p.setBackupCompressed}
            label="Compress the one-time backup"
            hint="Only applies if you save over a file that already exists." />
        </div>
        <div style={{ fontSize: 11.5, color: TEXT_LABEL, marginBottom: 16, lineHeight: 1.5, maxWidth: 620 }}>
          Overwriting an existing file asks for confirmation first. The new path becomes this
          session's save target, and the autosave journal follows it.
        </div>
        <Primary icon="saveAs" label="Choose Location & Save…" disabled={p.saving}
          onClick={() => { onClose(); p.saveWorldAs(); }} />
      </>);

    // ── Export ───────────────────────────────────────────────────────────
    case "export":
      return (<>
        <PaneHead title="Export"
          sub="Write the world out in another format. Exports never modify your world." />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
          <ExportRow icon="fullmap" title="PNG image" busy={p.exporting}
            desc="A top-down render of the whole map at one pixel per block, using the same colours the 2D view draws."
            onExport={() => { onClose(); p.exportPng(); }} />
          <ExportRow icon="properties" title="JSON" busy={p.exportingJson} disabled={!p.world}
            desc="The world header plus a chunk index, for scripting and diffing. Human-readable and small."
            onExport={() => { onClose(); p.exportJson(); }} />
          {p.enableExperimentalExport && (
            <ExportRow icon="axo" title="OBJ mesh" badge={<span style={expBadge()}>exp</span>} busy={p.exportingObj} disabled={!p.world}
              desc="Face-culled cubes plus ramp prisms and wedge pyramids, one material per block/paint combination. Opens in Blender."
              onExport={() => { onClose(); p.exportObj(); }} />
          )}
          {p.enableExperimentalExport && (
            <ExportRow icon="build" title="VMF (Source / Hammer)" badge={<span style={expBadge()}>exp</span>} disabled={!p.world}
              desc="The selection as editable Hammer brushwork — a 3D greedy box merge into cuboid brushes, with an optional skybox shell, light_environment and player start."
              onExport={() => { onClose(); p.exportVmf(); }} />
          )}
        </div>
        {!p.enableExperimentalExport && (
          <div style={{ fontSize: 11.5, color: TEXT_LABEL, lineHeight: 1.5 }}>
            JSON and additional hidden export features are experimental. Turn on <strong>experimental exports</strong> in Settings to see all of them.
          </div>
        )}
      </>);

    // ── Upload ───────────────────────────────────────────────────────────
    case "upload":
      return (<>
        <PaneHead title="Upload"
          sub="Publish this world to the Eden community server so others can download it in-game or from the world browser." />
        <TextList items={[
          ["What gets sent", "The world is uploaded exactly as it is in memory, compressed. Your local file is not modified and nothing else about your machine is transmitted."],
          ["Name and description", "The upload dialog takes the listing name and blurb. The world's internal name (the button in the top bar) is separate. You can rename it there first if you want them to match."],
          ["Save first", "Uploading does not save. If you want the same bytes on disk, press ⌘S before uploading."],
          ["Finding it again", "Fresh uploads appear at the top of the browser's date sort. As in the game itself, there is no way to delete, so treat a publish as permanent."],
        ]} />
        <Primary icon="upload" label="Upload This World…" disabled={!p.world}
          onClick={() => { onClose(); p.setShowUploadModal(true); }} />
      </>);

    // ── Properties ───────────────────────────────────────────────────────
    case "properties":
      return (<>
        <PaneHead title="World Properties" sub="Everything in the world's 192-byte header, read live." />
        {p.world ? (<>
          <RenameField onRenamed={bumpInfo} />
          <WorldInfoPanel refreshKey={infoKey} />
        </>) : (
          <div style={{ color: TEXT_DIM, fontSize: 12.5 }}>No world is open.</div>
        )}
      </>);

    // ── Settings ─────────────────────────────────────────────────────────
    case "settings":
      return (<>
        <PaneHead title="Settings"
          sub="The full preferences dialog covers appearance, memory budget, autosave, experimental features and the prefab folder. A few view toggles are repeated here because they change what you see immediately." />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 16, maxWidth: 620 }}>
          <QuickToggle label="Quad view" on={p.showSlicePanels} onToggle={() => p.setShowSlicePanels(!p.showSlicePanels)}
            hint="Hammer-style Top + Front + Side + 3D panes." />
          <QuickToggle label="3D fly-through pane" on={p.enable3dPane} onToggle={() => p.setEnable3dPane(!p.enable3dPane)}
            hint="Fills the fourth quad cell. Requires quad view." />
          <QuickToggle label="Docked sidebar" on={p.sidebarOpen} onToggle={p.onToggleSidebar}
            hint="Inspector, prefab library, elevation preview and undo history." />
          <QuickToggle label="Quick Actions bar" on={p.showQuickActions} onToggle={p.onToggleQuickActions}
            hint="Floating selection/clipboard pill under the ribbon." />
          <QuickToggle label="Experimental exports" on={p.enableExperimentalExport} onToggle={() => { onClose(); p.setShowSettings(true); }}
            hint="OBJ and VMF export. Changed in the full Settings dialog." readOnly />
        </div>
        <Primary icon="settings" label="Open Settings…" onClick={() => { onClose(); p.setShowSettings(true); }} />
      </>);

    // ── Help ─────────────────────────────────────────────────────────────
    case "help":
      return (<>
        <PaneHead title="Help"
          sub="The help window collects the keyboard map and a tour of each tool family. A few things worth knowing right now:" />
        <TextList items={[
          ["Getting around", <>Middle-drag pans from any tool; <Kbd>Space</Kbd> holds pan temporarily. <Kbd>Home</Kbd> fits the whole map, <Kbd>⌘±</Kbd> zooms, <Kbd>⌘⇧0</Kbd> zooms to the selection.</>],
          ["Selecting", <><Kbd>S</Kbd> rectangle, <Kbd>W</Kbd> magic wand, <Kbd>K</Kbd> lasso, <Kbd>J</Kbd> polygon. Wand and lasso make real shaped selections, not just bounding boxes.</>],
          ["Drawing", <><Kbd>P</Kbd> pen, <Kbd>B</Kbd> brush, <Kbd>L</Kbd> line, <Kbd>R</Kbd> rectangle, <Kbd>E</Kbd> ellipse, <Kbd>G</Kbd> polygon, <Kbd>I</Kbd> eyedropper. Digits <Kbd>1</Kbd>–<Kbd>5</Kbd> arm pinned blocks, <Kbd>6</Kbd>–<Kbd>0</Kbd> recent ones.</>],
          ["Sculpting", <><Kbd>[</Kbd> / <Kbd>]</Kbd> change radius, with <Kbd>⇧</Kbd> for strength. Escape mid-stroke reverts the whole stroke as one undo step.</>],
          ["Undo", <><Kbd>⌘Z</Kbd> / <Kbd>⌘⇧Z</Kbd>. Undo is chunk-scoped and byte-budgeted; the sidebar's History tab lists what is on each stack.</>],
          ["Escape", "Steps back through whatever is in progress — paste, a shape, the selection, a sculpt grab, a lasso — one level per press."],
        ]} />
        <Primary icon="help" label="Open Help" onClick={() => { onClose(); p.setShowHelp(true); }} />
      </>);

    // ── About ────────────────────────────────────────────────────────────
    case "about":
      return (<>
        <AboutPanel version={p.appVersion} compact />
      </>);

    // ── Close World ──────────────────────────────────────────────────────
    case "close":
      return (<>
        <PaneHead title="Close World"
          sub="Return to the splash screen and release this world's memory — its undo history, clipboard and staged temp file." />
        <div style={{ fontSize: 12.5, color: TEXT_DIM, lineHeight: 1.6, maxWidth: 620, marginBottom: 16 }}>
          If there are unsaved changes you will be asked to confirm first. Autosave state is kept, so
          a world closed by accident can still be recovered on the next launch.
        </div>
        <Primary icon="close" tone="danger" label="Close World" disabled={!p.world}
          onClick={() => { onClose(); p.closeWorld(); }} />
      </>);
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd style={{
      fontSize: 10.5, fontFamily: "ui-monospace,'SF Mono',monospace", color: TEXT,
      background: "rgba(255,255,255,.08)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14)",
      borderRadius: 3, padding: "0 4px", margin: "0 1px",
    }}>{children}</kbd>
  );
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
        <div style={{ fontSize: 12.5, fontWeight: 600, color: TEXT, display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          {title}{badge}
        </div>
        <Primary icon="export" label={busy ? "Exporting…" : "Export"} busy={busy}
          disabled={disabled || busy} onClick={onExport} title={`Export ${title}`} />
      </div>
      <div style={{ fontSize: 11.5, color: TEXT_DIM, lineHeight: 1.45 }}>{desc}</div>
    </div>
  );
}

function QuickToggle({ label, hint, on, onToggle, readOnly }: {
  label: string; hint: string; on: boolean; onToggle: () => void; readOnly?: boolean;
}) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={on}
      style={btnBase({
        display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 10px", textAlign: "left",
        background: "none", boxShadow: "none", color: TEXT, width: "100%",
      })}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,.06)")}
      onMouseLeave={e => (e.currentTarget.style.background = "none")}>
      <span style={{
        width: 28, height: 16, borderRadius: 8, flexShrink: 0, marginTop: 1, position: "relative",
        background: on ? "rgba(0,164,173,.55)" : "rgba(255,255,255,.09)",
        boxShadow: `inset 0 0 0 1px ${on ? EDEN_TEAL_READABLE : "rgba(255,255,255,.16)"}`,
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: "50%",
          background: on ? "#e8fbfd" : "#7a8488", transition: "left .12s",
        }} />
      </span>
      <span>
        <span style={{ fontSize: 12.5 }}>{label}{readOnly && <span style={{ color: TEXT_LABEL, fontSize: 11 }}> · read-only here</span>}</span>
        <span style={{ display: "block", fontSize: 11.5, color: TEXT_DIM, lineHeight: 1.45 }}>{hint}</span>
      </span>
    </button>
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
      <span style={{ fontSize: 12, color: TEXT_DIM, width: 52 }}>Name</span>
      <input
        value={value} aria-label="World name"
        title="Letters, numbers, spaces and apostrophes — max 32 characters"
        onChange={e => {
          const clean = e.target.value.split("").filter(c => allowed.test(c)).join("").slice(0, 32);
          setHint(clean !== e.target.value);
          setValue(clean);
        }}
        onKeyDown={e => { if (e.key === "Enter" && dirty) { p.onRenameBlur(value.trim()); onRenamed(); } }}
        style={{
          flex: 1, maxWidth: 300, background: "rgba(0,0,0,.35)", border: "none", borderRadius: 4,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14)", color: TEXT, fontSize: 13,
          padding: "5px 8px", outline: "none",
        }}
      />
      <Primary icon="save" label="Rename" disabled={!dirty}
        onClick={() => { p.onRenameBlur(value.trim()); onRenamed(); }} />
      {hint && <span style={{ color: "#f59e0b", fontSize: 11 }}>letters, numbers, spaces and ’ only</span>}
    </div>
  );
}
