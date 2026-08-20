/**
 * The ribbon's top bar: application-menu button · Undo/Redo · tab strip · world pill · Help ·
 * collapse. One row, 34px, matching the mockup.
 *
 * Tabs are real tabs — `role="tablist"` with arrow-key navigation. The selected tab's bottom stop
 * is exactly `SURFACE.body`'s top stop, so it *merges* into the ribbon body rather than floating
 * over it as the old bright blue pill did.
 */
import { useRef, type CSSProperties } from "react";
import appIcon from "../assets/app-icon.png";
import WorldNamePill from "../WorldNamePill";
import { useRibbon } from "./context";
import { Icon } from "./icons";
import type { RibbonTab } from "./props";
import {
  ACCENT, BORDER, CTX_ACCENT, FONT, HAIRLINE, ICON, IS_MAC, MAC_TRAFFIC_LIGHT_CLEARANCE, MOD,
  RADIUS, SHIFT,
  TAB_ACTIVE_BOT, TAB_ACTIVE_TOP, TEXT, TEXT_DIM, TEXT_LABEL, TOPBAR_BTN_H, TOP_BAR_HEIGHT, btnBase,
  btnDisabled, hexToRgbTriplet, lighten,
} from "./tokens";

/** The brand button's fill. Office 2010's File tab is *always* the app's accent colour, not a
 *  neutral control that lights up when open — it is the one permanently-coloured thing up here. */
const BRAND_RGB = hexToRgbTriplet(ACCENT.primary);

const PERMANENT: { id: RibbonTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "draw", label: "Draw" },
  { id: "sculpt", label: "Sculpt" },
  { id: "insert", label: "Insert" },
  { id: "view", label: "View" },
];

/**
 * Fixed widths for Undo/Redo. ⚠️ Load-bearing, not cosmetic: both buttons carry a stack-depth
 * count whose digit width changes on *every edit*, and an auto-width button therefore shoved the
 * whole tab strip sideways each time you drew a block. The count is clamped to "99+" so it can
 * never outgrow the box either.
 */
const QAT_W_LABELLED = 74;
const QAT_W_ICON = 46;

export default function TopBar({
  menuOpen, onToggleMenu, selFlash, clipFlash,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  selFlash: number;
  clipFlash: number;
}) {
  const { p, activeTab, setActiveTab } = useRibbon();
  const stripRef = useRef<HTMLDivElement>(null);

  const show3d = p.showSlicePanels && p.enable3dPane;
  const visible: RibbonTab[] = [
    ...PERMANENT.map(t => t.id),
    ...(show3d ? (["3d"] as RibbonTab[]) : []),
    ...(p.rawBounds ? (["selection"] as RibbonTab[]) : []),
    ...(p.clipboard ? (["paste"] as RibbonTab[]) : []),
  ];

  /** ←/→ move between tabs, Home/End jump to the ends — the standard tablist contract. */
  function onKeyDown(e: React.KeyboardEvent) {
    const i = visible.indexOf(activeTab);
    if (i < 0) return;
    let next: RibbonTab | null = null;
    if (e.key === "ArrowRight") next = visible[(i + 1) % visible.length];
    else if (e.key === "ArrowLeft") next = visible[(i - 1 + visible.length) % visible.length];
    else if (e.key === "Home") next = visible[0];
    else if (e.key === "End") next = visible[visible.length - 1];
    if (next) {
      e.preventDefault();
      setActiveTab(next);
      stripRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
    }
  }

  return (
    <div
      {...(IS_MAC ? { "data-tauri-drag-region": true } : null)}
      style={{
        height: TOP_BAR_HEIGHT, display: "flex", alignItems: "stretch", gap: 2,
        padding: IS_MAC ? `0 6px 0 ${MAC_TRAFFIC_LIGHT_CLEARANCE}px` : "0 6px 0 0",
        background: "transparent",
      }}
    >
      {/* Brand / application menu — Office 2010's File tab: a permanently accent-filled tab
          carrying the app's identity (icon + VuencEdit wordmark), lit by a glow that intensifies
          while the menu is open. Not `.rbn-btn`; see `.rbn-brand` in RIBBON_CSS. */}
      <button
        className="rbn-brand" type="button" onClick={onToggleMenu}
        title="VuencEdit — application menu: New, Open, Save, Export, Settings…"
        aria-haspopup="menu" aria-expanded={menuOpen} aria-label="VuencEdit application menu"
        style={{
          display: "flex", alignItems: "center", gap: 7, padding: "0 12px 0 9px",
          border: "none", cursor: "pointer", outline: "none", flexShrink: 0,
          margin: "3px 6px 3px 4px", borderRadius: RADIUS.md,
          background: menuOpen
            ? `linear-gradient(180deg, rgba(${BRAND_RGB},.55) 0%, rgba(${BRAND_RGB},.68) 100%)`
            : `linear-gradient(180deg, rgba(${BRAND_RGB},.30) 0%, rgba(${BRAND_RGB},.48) 100%)`,
          boxShadow: [
            `inset 0 0 0 1px rgba(${BRAND_RGB},.35)`,
            "inset 0 1px 0 rgba(255,255,255,.30)",
            `0 0 ${menuOpen ? 16 : 9}px rgba(${BRAND_RGB},${menuOpen ? 0.65 : 0.38})`,
          ].join(", "),
          color: "#ffffff", textShadow: "0 1px 1px rgba(0,0,0,.45)",
        }}
      >
        <img src={appIcon} alt="" style={{ width: 20, height: 20, borderRadius: RADIUS.md, imageRendering: "pixelated", flexShrink: 0 }} />
        <span style={{ fontSize: 13, lineHeight: 1, letterSpacing: -0.3, whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 800 }}>Vuenc</span>
          <span style={{ fontWeight: 400, opacity: 0.88 }}>Edit</span>
        </span>
      </button>

      {/* Undo / Redo — always visible, per the mockup, and fixed-width (see QAT_W_*). */}
      <QatButton icon="undo" label="Undo" showLabel count={p.undoDepth}
        title={`Undo (${MOD}Z) · ${p.undoDepth} available`} onClick={p.handleUndo} disabled={p.undoDepth === 0} />
      <QatButton icon="redo" label="Redo" count={p.redoDepth}
        title={`Redo (${MOD}${SHIFT}Z) · ${p.redoDepth} available`} onClick={p.handleRedo} disabled={p.redoDepth === 0} />

      <Sep />

      {/* Tab strip */}
      <div ref={stripRef} role="tablist" aria-label="Ribbon tabs" onKeyDown={onKeyDown}
        style={{ display: "flex", alignItems: "stretch", gap: 1, minWidth: 0, overflow: "hidden" }}>
        {PERMANENT.map(t => <Tab key={t.id} id={t.id} label={t.label} />)}
        {show3d && <Tab id="3d" label="3D" accent={CTX_ACCENT["3d"]} contextual />}
        {p.rawBounds && <Tab key={`sel-${selFlash}`} id="selection" label="Selection" accent={CTX_ACCENT.selection} contextual flash={selFlash > 0} />}
        {p.clipboard && (
          <Tab key={`clip-${clipFlash}`} id="paste" label="Clipboard" accent={CTX_ACCENT.clipboard} contextual flash={clipFlash > 0}
            onActivate={() => p.setTool("paste")} />
        )}
      </div>

      <div {...(IS_MAC ? { "data-tauri-drag-region": true } : null)} style={{ flex: 1, minWidth: 8 }} />

      {/* Right cluster: world pill · Help · collapse */}
      <WorldNamePill />
      <button
        className="rbn-btn" type="button" onClick={() => p.setShowHelp(true)}
        title="Help & shortcuts (?)" aria-label="Help"
        style={btnBase({
          display: "flex", alignItems: "center", gap: 5, padding: "0 9px", alignSelf: "center",
          height: TOPBAR_BTN_H, fontSize: FONT.body, color: TEXT,
        })}
      >
        <Icon name="help" size={ICON.xs} />
        Help
      </button>
      <button
        className="rbn-btn" type="button" onClick={() => p.onCollapse(!p.collapsed)}
        title={p.collapsed ? "Expand the ribbon" : "Collapse the ribbon"}
        aria-label={p.collapsed ? "Expand the ribbon" : "Collapse the ribbon"}
        aria-expanded={!p.collapsed}
        style={btnBase({
          width: 26, height: TOPBAR_BTN_H, alignSelf: "center", marginLeft: 3,
          display: "flex", alignItems: "center", justifyContent: "center",
        })}
      >
        <Icon name={p.collapsed ? "expandBar" : "collapse"} size={ICON.sm} tone="inherit" />
      </button>
    </div>
  );
}

function Sep() {
  return <div aria-hidden="true" style={{ width: 1, background: HAIRLINE, margin: "7px 5px", flexShrink: 0 }} />;
}

function QatButton({
  icon, label, title, onClick, disabled, count, showLabel,
}: {
  icon: "undo" | "redo"; label: string; title: string; onClick: () => void;
  disabled: boolean; count: number; showLabel?: boolean;
}) {
  return (
    <button
      className="rbn-btn" type="button" title={title} aria-label={label} onClick={onClick}
      aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
      style={btnBase({
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: 0,
        width: showLabel ? QAT_W_LABELLED : QAT_W_ICON,
        height: TOPBAR_BTN_H, alignSelf: "center", flexShrink: 0,
        fontSize: FONT.body, overflow: "hidden",
        ...(disabled ? btnDisabled : null),
      })}
    >
      <Icon name={icon} size={ICON.sm} tone={disabled ? "inherit" : "default"} />
      {showLabel && label}
      {/* Fixed box + tabular figures: the count changes on every edit and must not resize the button. */}
      <span style={{
        fontSize: FONT.micro, color: TEXT_LABEL, fontVariantNumeric: "tabular-nums",
        width: 18, textAlign: "left",
      }}>
        {count > 0 ? (count > 99 ? "99+" : count) : ""}
      </span>
    </button>
  );
}

/**
 * One tab. The selected tab merges into the body below it (its bottom stop *is* the body's top
 * stop); unselected tabs are flat text with a CSS hover (`.rbn-tab`, see `RIBBON_CSS` — they had
 * no hover state at all before, since they aren't `.rbn-btn`).
 *
 * Contextual tabs carry their hue as an **Aero-style glow** that intensifies sharply on selection,
 * replacing the 2px top strip that read as a hairline rather than as "this tab is special".
 * Unselected contextual tabs show the glow *fill* only (no outline ring) and match the selected
 * tab's height/margin so the fill sits flush with the ribbon body instead of floating with a gap;
 * the outline ring is reserved for the selected state so selection reads unambiguously.
 *
 * ⚠️ The glow is `inset`, not an outer `box-shadow`. The tab strip is `overflow: hidden` — which
 * is load-bearing, since at the 900px `minWidth` the strip must clip rather than run over the
 * world pill — so an outer glow would be sliced off at the strip's edges and along the bottom.
 * A selected contextual tab still ends on `TAB_ACTIVE_BOT` so it merges into the body exactly
 * like a permanent tab; only its top half is tinted.
 */
function Tab({
  id, label, accent, contextual, flash, onActivate,
}: {
  id: RibbonTab; label: string; accent?: string; contextual?: boolean; flash?: boolean;
  onActivate?: () => void;
}) {
  const { activeTab, setActiveTab, p, requestPeek } = useRibbon();
  const selected = activeTab === id;
  const rgb = accent ? hexToRgbTriplet(accent) : null;

  const background = rgb
    ? selected
      ? `linear-gradient(180deg, rgba(${rgb},.55) 0%, ${TAB_ACTIVE_BOT} 100%)`
      : `linear-gradient(180deg, rgba(${rgb},.20) 0%, rgba(${rgb},.05) 100%)`
    : selected
      ? `linear-gradient(180deg, ${TAB_ACTIVE_TOP} 0%, ${TAB_ACTIVE_BOT} 100%)`
      : "transparent";

  const glow = rgb
    ? selected
      // No bottom inset border here (unlike the unselected state below) — a selected tab's
      // bottom edge must sit flush with the body below it, not read as a floating outlined box.
      ? `inset 1px 0 0 rgba(${rgb},.9), inset -1px 0 0 rgba(${rgb},.9), inset 0 1px 0 rgba(${rgb},.9), inset 0 0 18px 2px rgba(${rgb},.55), inset 0 1px 0 rgba(255,255,255,.22)`
      // Unselected: glow fill only, no outline — and extended down flush with the
      // ribbon body (same height as the selected state) rather than floating with a gap.
      : `inset 0 0 9px rgba(${rgb},.28)`
    : null;

  const style: CSSProperties = {
    border: "none", cursor: "pointer", outline: "none", flexShrink: 0,
    alignSelf: "flex-end", position: "relative",
    height: selected || contextual ? TOP_BAR_HEIGHT - 3 : TOP_BAR_HEIGHT - 10,
    marginBottom: selected || contextual ? 0 : 3,
    padding: "0 13px", fontSize: FONT.tab, fontWeight: selected ? 600 : 500,
    borderRadius: `${RADIUS.lg}px ${RADIUS.lg}px 0 0`, whiteSpace: "nowrap",
    background,
    color: selected ? "#ffffff" : contextual ? lighten(accent!, 0.4) : TEXT_DIM,
    boxShadow: glow ?? (selected
      ? `inset 1px 0 0 ${BORDER.outline}, inset -1px 0 0 ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}`
      : "none"),
    textShadow: rgb
      ? selected ? `0 0 10px rgba(${rgb},.95), 0 1px 1px rgba(0,0,0,.5)` : `0 0 7px rgba(${rgb},.55)`
      : selected ? "0 1px 1px rgba(0,0,0,.4)" : undefined,
    // Consumed by @keyframes rbnCtxPulse, so the Clipboard tab flashes green instead of amber.
    ...(rgb ? ({ "--rbn-pulse": `rgba(${rgb},.6)` } as Record<string, string>) : null),
  };

  return (
    <button
      role="tab" type="button" data-tab={id} aria-selected={selected}
      className={`rbn-tab${flash ? " rbn-flash" : ""}`}
      aria-controls="ribbon-tabpanel" tabIndex={selected ? 0 : -1}
      title={contextual ? `${label} — contextual tab` : `${label} (double-click to collapse/expand the ribbon)`}
      onClick={() => {
        setActiveTab(id);
        onActivate?.();
        if (p.collapsed) requestPeek();
      }}
      onDoubleClick={() => p.onCollapse(!p.collapsed)}
      style={style}
    >
      {label}
    </button>
  );
}
