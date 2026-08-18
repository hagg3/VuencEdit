/**
 * Ribbon building blocks. Everything a tab draws is composed from these, so density, hover,
 * focus, pressed and disabled behaviour are decided once instead of being re-derived per button.
 *
 * The load-bearing rule is in `Group`: the control area is a **fixed-height box** (`GROUP_CONTENT_H`)
 * with `overflow: hidden`, and the bottom label strip is laid out after it. Group content can
 * therefore never push its own label out of the ribbon and get clipped — the failure mode the
 * previous `marginTop: auto` label had whenever a group's rows added up to more than the body.
 */
import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import NumberField from "../NumberField";
import { Icon, type IconName, type IconTone } from "./icons";
import {
  ACCENT, ARMED_RING, BORDER, BTN_RADIUS, COL_GAP, DANGER, FONT, FOCUS_RING, GROUP_CONTENT_H,
  GROUP_LABEL_H, GROUP_PAD_BOTTOM, GROUP_PAD_TOP, GROUP_PAD_X, HAIRLINE, ICON, LARGE_H, RADIUS,
  RAIL_W, ROW_GAP, SMALL_H, SPACE, SURFACE, TEXT, TEXT_DANGER, TEXT_DIM, TEXT_LABEL,
  btnActive, btnBase, btnDisabled, hexToRgbTriplet,
} from "./tokens";
import type { Tier } from "./layout";

export type Tone = "default" | "accent" | "danger";

const TONE_ICON: Record<Tone, IconTone> = { default: "default", accent: "accent", danger: "danger" };

/**
 * Injected once by the Ribbon shell. Hover/pressed/focus live in CSS because inline styles can't
 * express `:hover`/`:active`, and per-button state would be ~60 extra `useState`s per tab.
 *
 * ⚠️ The `!important` + `:not([data-active="true"]):not([aria-disabled="true"])` guard is
 * load-bearing: `btnBase` is an *inline* style, so without `!important` these rules never win, and
 * without the `:not(...)` pair they would stomp the armed and disabled looks.
 */
export const RIBBON_CSS = `
.eden-ribbon .rbn-btn { transition: background .1s, box-shadow .1s, filter .1s; }
.eden-ribbon .rbn-btn:not([data-active="true"]):not([aria-disabled="true"]):hover {
  background: linear-gradient(180deg, #414c58 0%, #323b45 100%) !important;
  box-shadow: inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 rgba(255,255,255,.14) !important;
}
.eden-ribbon .rbn-btn:not([data-active="true"]):not([aria-disabled="true"]):active {
  background: linear-gradient(180deg, #262d35 0%, #2f3841 100%) !important;
  box-shadow: inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 2px rgba(0,0,0,.45) !important;
}
/* Menu rows are rows, not buttons: they highlight, they don't grow a raised face. Higher
   specificity than the two rules above, which would otherwise give every popover row a bevel. */
.eden-ribbon .rbn-btn[role="menuitem"]:not([data-active="true"]):not([aria-disabled="true"]):hover {
  background: rgba(255,255,255,.09) !important;
  box-shadow: none !important;
}
.eden-ribbon .rbn-btn[role="menuitem"]:not([data-active="true"]):not([aria-disabled="true"]):active {
  background: rgba(255,255,255,.04) !important;
  box-shadow: none !important;
}
.eden-ribbon .rbn-btn[data-active="true"]:hover { filter: brightness(1.15); }
.eden-ribbon .rbn-btn[data-active="true"]:active { filter: brightness(0.88); }
/* The brand/File button is deliberately NOT .rbn-btn: it is a filled accent tab (Office 2010's
   File tab), so the neutral hover gradient above would stomp its fill. It gets its own hover. */
.eden-ribbon .rbn-brand { transition: filter .12s, box-shadow .12s; }
.eden-ribbon .rbn-brand:hover { filter: brightness(1.14); }
.eden-ribbon .rbn-brand:active { filter: brightness(0.92); }
/* Focus is its own colour so "focused" is never mistaken for "armed" (both used to be #00dde9). */
.eden-ribbon :focus-visible { outline: 1px solid ${FOCUS_RING}; outline-offset: 1px; }
/* Unselected tabs are not .rbn-btn, so they had no hover state at all until now. */
.eden-ribbon .rbn-tab:not([aria-selected="true"]):hover {
  background: rgba(255,255,255,.07);
  color: ${TEXT};
}
.eden-ribbon .rbn-range { accent-color: ${ACCENT.primary}; cursor: pointer; height: 14px; }
.eden-ribbon .rbn-body::-webkit-scrollbar { height: 5px; }
.eden-ribbon .rbn-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: ${RADIUS.md}px; }
/* Dual-thumb range: the two inputs are invisible hit targets over a painted track, so only the
   pointer-events pair matters here — the thumb's old gradient paint was dead weight. */
.eden-ribbon .zr-thumb { -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; }
.eden-ribbon .zr-thumb::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; pointer-events: all;
  width: 14px; height: 14px; border-radius: 50%; cursor: pointer;
}
/* Colour comes from --rbn-pulse, set inline per tab — the pulse used to be hardcoded amber and so
   flashed amber for the green Clipboard tab too. */
.eden-ribbon .rbn-flash { animation: rbnCtxPulse .45s ease-out; }
@keyframes rbnCtxPulse {
  0%   { box-shadow: 0 0 0 0 var(--rbn-pulse, rgba(0,164,173,.6)); }
  60%  { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .eden-ribbon .rbn-btn { transition: none; }
  .eden-ribbon .rbn-brand { transition: none; }
  .eden-ribbon .rbn-flash { animation: none; }
}
`;

// ── Layout helpers ────────────────────────────────────────────────────────────

export function Row({ children, gap = COL_GAP, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: "flex", alignItems: "center", gap, ...style }}>{children}</div>;
}

/** A vertical stack of small controls, top-aligned inside the fixed content box. */
export function Col({ children, gap = ROW_GAP, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>{children}</div>;
}

/** Office-style etched separator: one dark hairline with a light one painted beside it. The
 *  element stays 1px wide — the highlight is a box-shadow, so group widths don't shift. */
export function GroupDivider() {
  return (
    <div aria-hidden="true" style={{
      width: 1, background: BORDER.etchDark, boxShadow: `1px 0 0 ${BORDER.etchLight}`,
      alignSelf: "stretch", margin: `${SPACE.sm}px 1px`, flexShrink: 0,
    }} />
  );
}

/** Menu/popover row separator. `HomeTab` used to restate `HAIRLINE` as a literal here. */
export function MenuSeparator() {
  return <div aria-hidden="true" style={{ height: 1, background: HAIRLINE, margin: `${SPACE.xs}px 0` }} />;
}

// ── Group ─────────────────────────────────────────────────────────────────────

/** Slack allowed between a group's declared and rendered width before the dev guard complains. */
const WIDTH_TOLERANCE = 8;

export interface GroupProps {
  id: string;
  label: ReactNode;
  tier?: Tier;
  /** Declared full-tier width, used only by the dev-mode drift warning. */
  declaredWidth?: number;
  /** Dim + inert without unmounting, so neighbours never shift (the existing Home idiom). */
  dim?: boolean;
  /** Reason shown on the whole group while dimmed, and appended to the label. */
  dimNote?: ReactNode;
  children: ReactNode;
  /** Icon shown on the `compact` chevron. Defaults to a generic "more". */
  icon?: IconName;
  style?: CSSProperties;
}

export function Group({
  id, label, tier = "full", declaredWidth, dim, dimNote, children, icon = "more", style,
}: GroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [popupOpen, setPopupOpen] = useState(false);

  // Dev-only drift guard: declared widths (see each tab's SPECS) feed the pure solver, so they
  // must stay close to what the group actually renders. Warn rather than measure-and-relayout,
  // which would make the solve non-deterministic and untestable.
  //
  // ⚠️ **Two-sided on purpose.** It used to warn only when a group rendered *wider* than declared,
  // which meant the opposite mistake was silent: over-declaring reserves width the group never
  // uses, so the solver demotes the whole row earlier than it needs to and the tab carries dead
  // space no warning ever mentions. Both directions print the measured number, so a single dev
  // run yields the exact value to paste into the tab's SPECS **and** its `declaredWidth` prop —
  // the two copies must be updated together.
  //
  // Only the `full` tier is checked: `medium`/`compact` widths live solely in SPECS and are never
  // handed to a `Group`, so there is nothing here to compare them against.
  useEffect(() => {
    if (!import.meta.env.DEV || declaredWidth == null || tier !== "full") return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w === 0) return; // hidden tab / not laid out yet
      if (w > declaredWidth + WIDTH_TOLERANCE) {
        console.warn(`[ribbon] group "${id}" renders ${w}px but declares ${declaredWidth}px at full tier — overflowing; raise both copies to ${w}`);
      } else if (w < declaredWidth - WIDTH_TOLERANCE) {
        console.warn(`[ribbon] group "${id}" renders ${w}px but declares ${declaredWidth}px at full tier — ${declaredWidth - w}px of reserved dead space; lower both copies to ${w}`);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, declaredWidth, tier]);

  if (tier === "compact") {
    return (
      <div ref={ref} style={{ ...groupShell, ...style }}>
        <div style={groupBody}>
          <IconButton
            icon={icon}
            label={typeof label === "string" ? label : id}
            title={`${typeof label === "string" ? label : id} — click to open`}
            active={popupOpen}
            onClick={() => setPopupOpen(v => !v)}
            style={{ height: GROUP_CONTENT_H, width: 30, flexDirection: "column", gap: SPACE.sm }}
          />
          {popupOpen && (
            <Popover anchorRef={ref} onClose={() => setPopupOpen(false)}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: COL_GAP, padding: SPACE.md }}>{children}</div>
            </Popover>
          )}
        </div>
        <GroupLabel>{label}</GroupLabel>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      style={{ ...groupShell, ...(dim ? { opacity: 0.4 } : null), ...style }}
      aria-disabled={dim || undefined}
    >
      <div style={{ ...groupBody, ...(dim ? { pointerEvents: "none" as const } : null) }}>{children}</div>
      <GroupLabel>
        {label}
        {dim && dimNote ? <span style={{ color: TEXT_DIM, opacity: 0.9, marginLeft: SPACE.sm }}>{dimNote}</span> : null}
      </GroupLabel>
    </div>
  );
}

const groupShell: CSSProperties = {
  display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0,
  // `space-between` pins the label strip to the bottom even if the body is ever taller than
  // pad + content + label; the content box's own fixed height keeps it from growing into it.
  justifyContent: "space-between",
  padding: `${GROUP_PAD_TOP}px ${GROUP_PAD_X}px ${GROUP_PAD_BOTTOM}px`,
  position: "relative",
};
/** Fixed height + hidden overflow — this is what keeps the label strip on screen. */
const groupBody: CSSProperties = {
  height: GROUP_CONTENT_H, display: "flex", alignItems: "flex-start",
  gap: COL_GAP, overflow: "hidden", flexShrink: 0,
};

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      height: GROUP_LABEL_H, borderTop: `1px solid ${HAIRLINE}`, paddingTop: 1,
      fontSize: FONT.label, lineHeight: "13px", color: TEXT_LABEL, textAlign: "center",
      alignSelf: "stretch", userSelect: "none", whiteSpace: "nowrap",
      overflow: "hidden", textOverflow: "ellipsis",
    }}>
      {children}
    </div>
  );
}

// ── Buttons ───────────────────────────────────────────────────────────────────

interface CommonBtn {
  label: string;
  title: string;
  /** Receives the event so callers can anchor a portal/popover on the clicked element. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  tone?: Tone;
  /** Accent for the armed state — tool-family colour coding. Defaults to Eden teal. */
  accent?: string;
  badge?: ReactNode;
  style?: CSSProperties;
}

function stateStyle(active?: boolean, disabled?: boolean, accent?: string): CSSProperties {
  return {
    ...(active ? btnActive(accent) : null),
    ...(disabled ? btnDisabled : null),
  };
}

function a11y(active?: boolean, disabled?: boolean) {
  return {
    "data-active": active ? "true" : undefined,
    "aria-disabled": disabled ? true : undefined,
    tabIndex: disabled ? -1 : undefined,
  } as const;
}

/** Large: 82px tall, icon over label. The mockup's primary commands (Paste, Pan, Delete, Fill…). */
export function LargeButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, badge, style, iconNode,
}: CommonBtn & { icon: IconName; iconNode?: ReactNode }) {
  return (
    <button
      className="rbn-btn" type="button" title={title} aria-label={label} onClick={onClick}
      {...a11y(active, disabled)}
      style={btnBase({
        height: LARGE_H, minWidth: 52, padding: `${SPACE.md}px ${SPACE.md}px 5px`,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: SPACE.md, fontSize: FONT.body, lineHeight: "13px",
        color: tone === "danger" ? TEXT_DANGER : TEXT,
        ...stateStyle(active, disabled, accent),
        ...style,
      })}
    >
      {iconNode ?? <Icon name={icon} size={ICON.lg} tone={active ? "inherit" : TONE_ICON[tone]} />}
      <span style={{ maxWidth: 86, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {badge}
    </button>
  );
}

/** Small: 26px tall, icon + label on one line. Everything secondary. */
export function SmallButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, badge, style, full,
}: CommonBtn & { icon?: IconName; full?: boolean }) {
  return (
    <button
      className="rbn-btn" type="button" title={title} aria-label={label} onClick={onClick}
      {...a11y(active, disabled)}
      style={btnBase({
        height: SMALL_H, padding: "0 7px", display: "flex", alignItems: "center", gap: 5,
        justifyContent: full ? "flex-start" : "center", width: full ? "100%" : undefined,
        color: tone === "danger" ? TEXT_DANGER : TEXT,
        ...stateStyle(active, disabled, accent),
        ...style,
      })}
    >
      {icon && <Icon name={icon} size={ICON.sm} tone={active ? "inherit" : TONE_ICON[tone]} />}
      {label && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>}
      {badge}
    </button>
  );
}

/** Square icon-only button (segmented sets, tool grids, nudge arrows). Needs both label + title. */
export function IconButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, style, size = ICON.sm, iconNode,
}: CommonBtn & { icon: IconName; size?: number; iconNode?: ReactNode }) {
  return (
    <button
      className="rbn-btn" type="button" title={title} aria-label={label} onClick={onClick}
      {...a11y(active, disabled)}
      style={btnBase({
        height: SMALL_H, width: SMALL_H, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 0, color: tone === "danger" ? TEXT_DANGER : TEXT,
        ...stateStyle(active, disabled, accent),
        ...style,
      })}
    >
      {iconNode ?? <Icon name={icon} size={size} tone={active ? "inherit" : TONE_ICON[tone]} />}
    </button>
  );
}

/**
 * A primary command that renders large at `full` tier and drops to a small icon+label row at
 * `medium`. This is the only place the tier→size mapping lives, so every tab demotes identically.
 */
export function CommandButton({
  tier = "full", iconNode, full, ...rest
}: CommonBtn & { icon: IconName; tier?: Tier; iconNode?: ReactNode; full?: boolean }) {
  return tier === "full"
    ? <LargeButton {...rest} iconNode={iconNode} />
    : <SmallButton {...rest} full={full} />;
}

export function ToggleButton(p: CommonBtn & { icon?: IconName; pressed: boolean; full?: boolean }) {
  const { pressed, ...rest } = p;
  return (
    <span style={{ display: "contents" }}>
      <SmallButton {...rest} active={pressed} />
    </span>
  );
}

/**
 * A large command paired with a narrow `⌄` half that opens a menu — the mockup's Paste and Block
 * buttons. The two halves are separate `<button>`s so the primary action stays one click.
 */
export function SplitButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, menu, menuTitle, iconNode, style,
}: CommonBtn & { icon: IconName; menu: () => ReactNode; menuTitle: string; iconNode?: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={wrapRef} style={{ display: "flex", alignItems: "stretch", gap: 1, position: "relative", ...style }}>
      <LargeButton
        icon={icon} iconNode={iconNode} label={label} title={title} onClick={onClick}
        active={active} disabled={disabled} tone={tone} accent={accent}
        style={{ borderRadius: `${BTN_RADIUS}px 0 0 ${BTN_RADIUS}px` }}
      />
      <button
        className="rbn-btn" type="button" title={menuTitle} aria-label={menuTitle}
        aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(v => !v)} {...a11y(open, disabled)}
        style={btnBase({
          height: LARGE_H, width: RAIL_W, display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: `0 ${BTN_RADIUS}px ${BTN_RADIUS}px 0`, padding: 0,
          ...stateStyle(open, disabled, accent),
        })}
      >
        <Icon name="split" size={ICON.xs} tone="inherit" />
      </button>
      {open && (
        <Popover anchorRef={wrapRef} onClose={() => setOpen(false)}>
          {menu()}
        </Popover>
      )}
    </div>
  );
}

/** A small labelled button that opens a menu — the mockup's "Mode ⌄". */
export function DropdownButton({
  icon, label, title, disabled, full, menu, style, active, accent, minWidth = 170,
}: CommonBtn & { icon?: IconName; full?: boolean; menu: () => ReactNode; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={ref} style={{ position: "relative", display: "flex", width: full ? "100%" : undefined, ...style }}>
      <SmallButton
        icon={icon} label={label} title={title} disabled={disabled} full={full} accent={accent}
        active={open || active} onClick={() => setOpen(v => !v)}
        badge={<Icon name="split" size={ICON.xs} tone="inherit" style={{ marginLeft: full ? "auto" : 0 }} />}
      />
      {open && (
        <Popover anchorRef={ref} onClose={() => setOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP, padding: SPACE.md, minWidth }}
            onClick={() => setOpen(false)}>
            {menu()}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** The mockup's tall `⌄` rail at the end of a row of large buttons — "more of this kind". */
export function MoreChevron({ title, children }: { title: string; children: () => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={ref} style={{ position: "relative", display: "flex" }}>
      <button
        className="rbn-btn" type="button" title={title} aria-label={title}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
        {...a11y(open, false)}
        style={btnBase({
          height: LARGE_H, width: RAIL_W, padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          ...(open ? btnActive() : null),
        })}
      >
        <Icon name="split" size={ICON.xs} tone="inherit" />
      </button>
      {open && (
        <Popover anchorRef={ref} onClose={() => setOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP, padding: SPACE.md, minWidth: 150 }}
            onClick={() => setOpen(false)}>
            {children()}
          </div>
        </Popover>
      )}
    </div>
  );
}

// ── Popover ───────────────────────────────────────────────────────────────────

/**
 * Portaled flyout anchored under `anchorRef`. Portaled for two reasons: the ribbon body clips
 * overflow, *and* the ribbon's own `z-index: 100` stacking context would otherwise trap the panel
 * underneath the docked sidebar (z-index 120) no matter how high its own z-index went.
 *
 * Chrome is `SURFACE.popover` — the ribbon's own material. It used to be `glassMenuPanel`, the
 * app-wide warm-brown modal glass, which read as a foreign object over a cool slate ribbon.
 * Escape is handled capture-phase + `stopPropagation` so App's global step-back doesn't also fire.
 */
export function Popover({
  anchorRef, onClose, onEscape, children, align = "left", role = "menu", ariaLabel, style,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /**
   * Escape handler, defaulting to `onClose`. Override it when the panel owns an inner gesture
   * Escape should step back from first: the listener below is **capture-phase on `window`**, so a
   * child input can't `stopPropagation()` its way out of being closed.
   */
  onEscape?: () => void;
  children: ReactNode;
  align?: "left" | "right";
  role?: "menu" | "dialog";
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = panelRef.current;
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "right" ? r.right - w : r.left;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    let top = r.bottom + 2;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 2);
    setPos({ top, left });
  }, [anchorRef, align]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); (onEscape ?? onClose)(); }
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchorRef, onClose, onEscape]);

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className="eden-ribbon"
      style={{
        background: SURFACE.popover,
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 10px 28px rgba(0,0,0,.6)`,
        borderRadius: RADIUS.lg,
        position: "fixed",
        top: pos?.top ?? -9999, left: pos?.left ?? -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 500, color: TEXT, fontSize: FONT.body,
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── Composite controls ────────────────────────────────────────────────────────

/** A labelled range slider on one 26px row — the ribbon's only single-value slider form. */
export function SliderRow({
  label, value, min, max, step = 1, onChange, onCommit, format, disabled, accent = ACCENT.primary,
  width = 78, labelWidth = 46, title,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; onCommit?: (v: number) => void;
  format?: (v: number) => string; disabled?: boolean; accent?: string;
  width?: number; labelWidth?: number; title?: string;
}) {
  const id = useId();
  return (
    <div title={title} style={{ display: "flex", alignItems: "center", gap: 5, height: SMALL_H, ...(disabled ? btnDisabled : null) }}>
      <label htmlFor={id} style={{ color: TEXT_DIM, fontSize: FONT.label, minWidth: labelWidth, userSelect: "none" }}>{label}</label>
      <input
        id={id} type="range" className="rbn-range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        onPointerUp={e => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => onCommit?.(Number((e.target as HTMLInputElement).value))}
        style={{ width, accentColor: accent }}
      />
      <span style={{ color: TEXT, fontSize: FONT.label, fontVariantNumeric: "tabular-nums", minWidth: 26, textAlign: "right" }}>
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/**
 * Dual-thumb range over one painted track. Promoted out of `SelectionTab`, where it was hand-built
 * from five untokenised blues; the two `<input type="range">`s are invisible hit targets (see the
 * `.zr-thumb` rules) stacked over the painted track below them.
 */
export function RangeSlider({
  lo, hi, min, max, onLo, onHi, accent = ACCENT.primary, width = 156, ariaLabelLo, ariaLabelHi,
}: {
  lo: number; hi: number; min: number; max: number;
  onLo: (v: string) => void; onHi: (v: string) => void;
  accent?: string; width?: number; ariaLabelLo: string; ariaLabelHi: string;
}) {
  const span = Math.max(1, max - min);
  const loPct = ((Math.min(lo, hi) - min) / span) * 100;
  const hiPct = ((Math.max(lo, hi) - min) / span) * 100;
  const rgb = hexToRgbTriplet(accent);

  const thumb = (pct: number, bright: boolean): CSSProperties => ({
    position: "absolute", top: 8, left: `calc(${pct}% - 5px)`, width: 10, height: 10,
    borderRadius: "50%", pointerEvents: "none",
    background: bright ? `rgb(${rgb})` : `rgba(${rgb},.65)`,
    boxShadow: `0 0 0 1px ${BORDER.outline}, inset 0 1px 0 rgba(255,255,255,.35)`,
  });

  return (
    <div style={{ position: "relative", width, height: SMALL_H, flexShrink: 0 }}>
      <div aria-hidden="true" style={{
        position: "absolute", top: 11, left: 4, right: 4, height: 4, borderRadius: RADIUS.sm,
        pointerEvents: "none", boxShadow: `inset 0 0 0 1px ${BORDER.outline}`,
        background: `linear-gradient(to right, ${SURFACE.well} 0%, ${SURFACE.well} ${loPct}%, rgb(${rgb}) ${loPct}%, rgb(${rgb}) ${hiPct}%, ${SURFACE.well} ${hiPct}%, ${SURFACE.well} 100%)`,
      }} />
      <input type="range" className="zr-thumb" aria-label={ariaLabelLo} min={min} max={max} value={lo}
        onChange={e => onLo(e.target.value)}
        style={{ position: "absolute", width: "100%", height: "100%", margin: 0, opacity: 0.001 }} />
      <input type="range" className="zr-thumb" aria-label={ariaLabelHi} min={min} max={max} value={hi}
        onChange={e => onHi(e.target.value)}
        style={{ position: "absolute", width: "100%", height: "100%", margin: 0, opacity: 0.001 }} />
      <div aria-hidden="true" style={thumb(loPct, false)} />
      <div aria-hidden="true" style={thumb(hiPct, true)} />
    </div>
  );
}

/** Radio-style row of small buttons. */
export function Segmented<T extends string>({
  label, value, options, onChange, accent, ariaLabel,
}: {
  label?: string; value: T; ariaLabel: string;
  options: { id: T; label: string; title?: string; icon?: IconName }[];
  onChange: (v: T) => void; accent?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} style={{ display: "flex", alignItems: "center", gap: COL_GAP, height: SMALL_H }}>
      {label && <FieldLabel>{label}</FieldLabel>}
      {options.map(o => (
        <button
          key={o.id} role="radio" aria-checked={value === o.id} className="rbn-btn" type="button"
          title={o.title ?? o.label} onClick={() => onChange(o.id)} data-active={value === o.id ? "true" : undefined}
          style={btnBase({
            height: SMALL_H, padding: o.icon && !o.label ? 0 : "0 7px",
            width: o.icon && !o.label ? SMALL_H : undefined,
            display: "flex", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
            ...(value === o.id ? btnActive(accent) : null),
          })}
        >
          {o.icon && <Icon name={o.icon} size={ICON.sm} tone={value === o.id ? "inherit" : "default"} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small caption under a tool grid — names the armed tool, which icons alone can't. */
export function Caption({ children, tone = TEXT_DIM }: { children: ReactNode; tone?: string }) {
  return (
    <div style={{
      fontSize: FONT.label, color: tone, textAlign: "center", alignSelf: "stretch",
      fontWeight: 600, height: 13, lineHeight: "13px", overflow: "hidden",
      textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "none",
    }}>
      {children}
    </div>
  );
}

/** Plain menu row for popovers and split menus. */
export function MenuItem({
  label, onClick, icon, active, danger, shortcut, disabled, title,
}: {
  label: ReactNode; onClick?: () => void; icon?: IconName; active?: boolean;
  danger?: boolean; shortcut?: string; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button" role="menuitem" className="rbn-btn" title={title} onClick={onClick}
      {...a11y(active, disabled)}
      style={btnBase({
        display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left",
        padding: `0 ${SPACE.lg}px`, height: 24, background: "none", boxShadow: "none",
        color: danger ? TEXT_DANGER : TEXT,
        ...(active ? btnActive() : null),
        ...(disabled ? btnDisabled : null),
      })}
    >
      {icon && <Icon name={icon} size={ICON.sm} tone={danger ? "danger" : "default"} />}
      <span style={{ flex: 1 }}>{label}</span>
      {shortcut && <span style={{ fontSize: FONT.micro, color: TEXT_LABEL }}>{shortcut}</span>}
    </button>
  );
}

// ── Small shared parts ────────────────────────────────────────────────────────

const BADGE_TONE: Record<"exp" | "perf" | "ok", { fg: string; rgb: string; text: string; title: string }> = {
  exp: { fg: "#e0a95a", rgb: hexToRgbTriplet(ACCENT.warm), text: "exp", title: "Experimental" },
  perf: { fg: TEXT_DANGER, rgb: hexToRgbTriplet(DANGER), text: "⚡", title: "Performance-intensive" },
  ok: { fg: "#7fc994", rgb: hexToRgbTriplet(ACCENT.green), text: "✓", title: "" },
};

/**
 * The one badge treatment. Replaces `Exp()` copy-pasted verbatim into four tabs plus `Perf()` in
 * ThreeDTab — and moves them off `border: 1px solid` onto the ribbon's `inset 0 0 0 1px` hairline
 * idiom, so a badge's outline is the same weight as every control's.
 */
export function Badge({
  tone = "exp", children, style, title,
}: { tone?: "exp" | "perf" | "ok"; children?: ReactNode; style?: CSSProperties; title?: string }) {
  const t = BADGE_TONE[tone];
  return (
    <span title={title ?? t.title ?? undefined} style={{
      fontSize: FONT.micro - 1, lineHeight: "12px", color: t.fg,
      background: `rgba(${t.rgb},.14)`, boxShadow: `inset 0 0 0 1px rgba(${t.rgb},.35)`,
      borderRadius: RADIUS.sm, padding: "0 3px", marginLeft: SPACE.xs, flexShrink: 0, ...style,
    }}>{children ?? t.text}</span>
  );
}

/** The ribbon's inline field label. Was `<span style={{color: TEXT_DIM, fontSize: 10, width: N}}>`
 *  at ~16 sites, with N drawn from eight different values. */
export function FieldLabel({
  children, width, align = "left", title,
}: { children: ReactNode; width?: number; align?: "left" | "right"; title?: string }) {
  return (
    <span title={title} style={{
      color: TEXT_DIM, fontSize: FONT.label, userSelect: "none", flexShrink: 0,
      width, textAlign: align, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/**
 * The one colour-cell treatment. There used to be three for the same concept: the palette hotbar
 * (22px, ring `#00dde9`), InsertTab's leaf colours (14px, ring `#4ade80`) and SelectionTab's block
 * chip (14px, no ring at all).
 */
export function Swatch({
  color, url, size = 14, selected, empty, style,
}: { color?: string; url?: string | null; size?: number; selected?: boolean; empty?: boolean; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: RADIUS.sm, flexShrink: 0, display: "block",
      background: empty ? "rgba(255,255,255,.03)" : color,
      backgroundImage: url ? `url(${url})` : undefined,
      backgroundSize: "cover", imageRendering: url ? "pixelated" : undefined,
      boxShadow: selected
        ? `inset 0 0 0 1px rgba(0,0,0,.55), 0 0 0 2px ${ARMED_RING}`
        : `inset 0 0 0 1px rgba(255,255,255,${empty ? ".10" : ".20"})`,
      ...style,
    }} />
  );
}

/** `NumberField` in the ribbon's recessed well. Every call site used to hand-spread
 *  `{...fieldStyle, width: N}`. */
export function NumField({
  value, onChange, min, max, width = 44, ariaLabel, title, disabled, style,
}: {
  value: number; onChange: (v: number) => void; min?: number; max?: number;
  width?: number; ariaLabel: string; title?: string; disabled?: boolean; style?: CSSProperties;
}) {
  return (
    <NumberField
      value={value} onChange={onChange} min={min} max={max} title={title} disabled={disabled}
      aria-label={ariaLabel}
      style={{
        background: SURFACE.well, border: "none",
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 2px 3px rgba(0,0,0,.35)`,
        color: TEXT, borderRadius: RADIUS.md, padding: "1px 4px", fontSize: FONT.body,
        textAlign: "center", outline: "none", height: 20, width, ...style,
      }}
    />
  );
}

/** Labelled checkbox. Replaces raw `<input type="checkbox" style={{accentColor:"#3b82f6"}}>`. */
export function Check({
  checked, onChange, label, title, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <label title={title} style={{
      display: "flex", alignItems: "center", gap: 5, height: SMALL_H, userSelect: "none",
      cursor: disabled ? "default" : "pointer", ...(disabled ? btnDisabled : null),
    }}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: ACCENT.primary, margin: 0 }} />
      <span style={{ color: TEXT_DIM, fontSize: FONT.label }}>{label}</span>
    </label>
  );
}
