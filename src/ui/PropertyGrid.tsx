/**
 * Property-grid primitives for the docked sidebar's Inspector tab (UI redesign r3, Stage 14.11).
 *
 * `Section` is a collapsible header + body — the sidebar's replacement for the old bespoke
 * ▶/▼ disclosures each panel (`ElevationPreviewPanel`, `SignsList`) hand-rolled its own copy of.
 * `PropRow`/`PropGrid` are label/value rows in the Visual Studio / Xcode "inspector" idiom: a
 * left-aligned label in `TEXT_LABEL` and a right-aligned, tabular-nums monospace value — every
 * numeric readout in the Inspector tab (Selection's Size/Z range/Volume/Shape) goes through these
 * instead of a bespoke `<div>` layout per panel.
 *
 * Open/closed state persists in one raw localStorage key (`sidebar_sections`), the same idiom as
 * `ribbon_collapsed` — a plain per-install UI preference, not an `AppSettings` field.
 */
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../ribbon/icons";
import { FONT, HAIRLINE, ICON, SPACE, TEXT, TEXT_LABEL, TEXT_META } from "../ribbon/tokens";

/** Monospace stack for property values — matches the canvas HUD labels elsewhere in the Inspector
 *  (`SelectionInspector`'s ortho-view caption uses the same "monospace" family). Not a CSS var:
 *  there's no themed mono token yet, and this is a font-family, not a colour. */
export const PROP_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const SECTION_STORAGE_KEY = "sidebar_sections";

function readSectionState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, boolean> : {};
  } catch { return {}; }
}

// Module-level cache so every `Section` on the page shares one parsed blob instead of re-reading
// and re-parsing localStorage per mount (the sidebar renders several of these at once).
let sectionStateCache: Record<string, boolean> | null = null;
function sectionState(): Record<string, boolean> {
  if (!sectionStateCache) sectionStateCache = readSectionState();
  return sectionStateCache;
}
function writeSectionState(id: string, open: boolean) {
  const next = { ...sectionState(), [id]: open };
  sectionStateCache = next;
  try { localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

export interface SectionProps {
  /** Persistence key — must be unique within the sidebar (mirrors the tour anchors' "Group ids
   *  aren't globally unique" trap: two different tabs may each have a section named "extrude"). */
  id: string;
  title: string;
  /** Right-aligned mono meta text in the header (e.g. a count, "ortho", a dimension string). */
  meta?: string;
  icon?: IconName;
  /** Falls back to this the first time a section is seen — a returning user's explicit choice
   *  (recorded in `sidebar_sections`) always wins over a later default change. */
  defaultOpen?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

export function Section({ id, title, meta, icon, defaultOpen = true, children, style }: SectionProps) {
  const [open, setOpen] = useState(() => {
    const s = sectionState();
    return id in s ? s[id] : defaultOpen;
  });
  const toggle = useCallback(() => {
    setOpen(v => { const next = !v; writeSectionState(id, next); return next; });
  }, [id]);

  return (
    <div style={{ boxShadow: `inset 0 -1px 0 ${HAIRLINE}`, ...style }}>
      <div
        role="button" tabIndex={0} aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
        style={{
          display: "flex", alignItems: "center", gap: SPACE.sm, minHeight: 26, padding: "4px 2px",
          cursor: "pointer", userSelect: "none", fontWeight: 700, fontSize: FONT.label,
          letterSpacing: "0.06em", textTransform: "uppercase", color: TEXT_LABEL,
        }}
      >
        <Icon name={open ? "expandBar" : "right"} size={ICON.xs} tone="default" />
        {icon && <Icon name={icon} size={ICON.xs} tone="default" />}
        <span style={{ flex: 1 }}>{title}</span>
        {meta && (
          <span style={{
            fontFamily: PROP_MONO, fontWeight: 400, textTransform: "none", letterSpacing: 0,
            color: TEXT_META, fontSize: FONT.label,
          }}>{meta}</span>
        )}
      </div>
      {open && <div style={{ padding: "2px 2px 10px", display: "flex", flexDirection: "column", gap: SPACE.md }}>{children}</div>}
    </div>
  );
}

export interface PropRowProps {
  label: ReactNode;
  value: ReactNode;
  title?: string;
}

/** One label/value line. Value is right-aligned, tabular-nums, monospace — a property grid, not
 *  prose. */
export function PropRow({ label, value, title }: PropRowProps) {
  return (
    <div title={title} style={{
      display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px",
      fontSize: FONT.body, lineHeight: "18px",
    }}>
      <span style={{ color: TEXT_LABEL }}>{label}</span>
      <span style={{
        textAlign: "right", fontFamily: PROP_MONO, fontVariantNumeric: "tabular-nums", color: TEXT,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{value}</span>
    </div>
  );
}

/** A whole grid of rows in one call — the common case (`PropGrid rows={[...]}`). */
export function PropGrid({ rows }: { rows: PropRowProps[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {rows.map((r, i) => <PropRow key={i} {...r} />)}
    </div>
  );
}
