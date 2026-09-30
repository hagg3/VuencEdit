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
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DialogLayerContext } from "../ui/Dialog";
import NumberField from "../NumberField";
import { Icon, type IconName, type IconTone } from "./icons";
import {
  ACCENT, ARMED_RING, BORDER, BTN_RADIUS, COL_GAP, DANGER, FONT, GRAD_HOVER, GRAD_PRESSED,
  GROUP_CONTENT_H, GROUP_LABEL_H, GROUP_PAD_BOTTOM, GROUP_PAD_TOP, GROUP_PAD_X, HAIRLINE, ICON,
  LARGE_H, POPUP_BTN_W, RADIUS, RAIL_W, ROW_GAP, SHADOW_HOVER, SHADOW_PRESSED, SMALL_H, SPACE, SURFACE, TEXT,
  TEXT_DANGER, TEXT_DIM, TEXT_LABEL, TEXT_META, CUR_ICON, btnActive, btnBase, btnDisabled, currentRow, hexToRgbTriplet,
} from "./tokens";
import { MOTION, RAMP, rgba } from "../theme/theme";
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
.eden-ribbon .rbn-btn { transition: background .09s, box-shadow .09s, filter .09s; }
.eden-ribbon .rbn-btn:not([data-active="true"]):not([aria-disabled="true"]):hover {
  background: ${GRAD_HOVER} !important;
  box-shadow: ${SHADOW_HOVER} !important;
}
.eden-ribbon .rbn-btn:not([data-active="true"]):not([aria-disabled="true"]):active {
  background: ${GRAD_PRESSED} !important;
  box-shadow: ${SHADOW_PRESSED} !important;
}
/* Menu rows are rows, not buttons: hover is the faint lift, never a raised face; the current
   option (data-active) is pushed in (Stage 14.2). Higher specificity than the two rules above,
   which would otherwise give every popover row a bevel. */
.eden-ribbon .rbn-btn[role="menuitem"]:not([data-active="true"]):not([aria-disabled="true"]):hover,
.eden-ribbon .rbn-btn[role="option"]:not([data-active="true"]):not([aria-disabled="true"]):hover {
  background: var(--vx-lift-bg) !important;
  box-shadow: var(--vx-lift-shadow) !important;
}
.eden-ribbon .rbn-btn[role="menuitem"]:not([data-active="true"]):not([aria-disabled="true"]):active,
.eden-ribbon .rbn-btn[role="option"]:not([data-active="true"]):not([aria-disabled="true"]):active {
  background: rgba(255,255,255,.03) !important;
  box-shadow: none !important;
}
.eden-ribbon .rbn-btn[data-active="true"]:hover { filter: brightness(1.12); }
.eden-ribbon .rbn-btn[data-active="true"]:active { filter: brightness(0.9); }
.eden-ribbon .rbn-btn[role="menuitem"][data-active="true"]:hover,
.eden-ribbon .rbn-btn[role="option"][data-active="true"]:hover { filter: none; }
/* The brand/File button is deliberately NOT .rbn-btn: it is a filled accent tab (Office 2010's
   File tab), so the neutral hover gradient above would stomp its fill. It gets its own hover. */
.eden-ribbon .rbn-brand { transition: filter .12s, box-shadow .12s; }
.eden-ribbon .rbn-brand:hover { filter: brightness(1.14); }
.eden-ribbon .rbn-brand:active { filter: brightness(0.92); }
/* Focus: the theme stylesheet's app-wide near-white ring (FOCUS_RING ≠ ARMED_RING). */
/* Unselected tabs are not .rbn-btn, so they had no hover state at all until now. */
.eden-ribbon .rbn-tab:not([aria-selected="true"]):hover {
  background: var(--vx-lift-bg);
  color: ${TEXT};
}
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
   flashed amber for the green Clipboard tab too. Gated on data-motion="full" (14.13's JS gate) —
   static under reduced motion means simply no pulse, rather than a second reduced-motion mechanism
   (an earlier @media (prefers-reduced-motion) block did this; removed in favour of the one JS gate
   every other motion-gated rule in this file uses — see src/theme/motion.ts). */
:root[data-motion="full"] .eden-ribbon .rbn-flash { animation: rbnCtxPulse .45s ease-out; }
@keyframes rbnCtxPulse {
  0%   { box-shadow: 0 0 0 0 var(--rbn-pulse, ${rgba(ACCENT.primary, 0.6)}); }
  60%  { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
/* ⌘K reveal (14.6): a static outline + glow for 1.3 s — unscoped, because a compact group's popup
   is portaled outside .eden-ribbon. The pulse is motion, so it only runs under data-motion="full"
   (14.13's JS gate); until then, and under reduced motion, the static outline is the whole cue. */
.cmd-flash { outline: 2px solid ${ACCENT.primary} !important; outline-offset: 1px; box-shadow: 0 0 10px ${rgba(ACCENT.primary, 0.55)} !important; }
:root[data-motion="full"] .cmd-flash { animation: cmdFlash 1.3s ease-out; }
@keyframes cmdFlash {
  0%, 30%, 60% { outline-color: ${ACCENT.primary}; }
  15%, 45%     { outline-color: transparent; }
}
/* Motion profile B (Stage 14.13): a Popover's enter (fade + scale-in, ≤180ms — MOTION.chromeMs) and
   a contextual tab's fade-in when it first appears. Both transform/opacity only, both gated on
   data-motion="full" — under "reduced" (or before the app has resolved a value at all) the element
   just appears, which is what makes reduced motion "the absence of a rule" rather than a second
   code path. */
:root[data-motion="full"] .vx-popover-enter {
  animation: vxPopoverIn ${MOTION.chromeMs}ms ${MOTION.easeEnter} both;
}
@keyframes vxPopoverIn {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
:root[data-motion="full"] .rbn-tab.vx-ctx-tab-enter {
  animation: vxCtxTabIn ${MOTION.chromeMs}ms ${MOTION.easeEnter} both;
}
@keyframes vxCtxTabIn {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

// ── Layout helpers ────────────────────────────────────────────────────────────

export function Row({ children, gap = COL_GAP, style, inert }: { children: ReactNode; gap?: number; style?: CSSProperties; inert?: boolean }) {
  return <div style={{ display: "flex", alignItems: "center", gap, ...style }} inert={inert}>{children}</div>;
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

/** `data-tier` on the group's own root div mirrors the rendered tier — read by both the dev
 *  drift guard's console message and `widthHarvester.ts` (Stage 14.7), which has no other way to
 *  know which tier a measured `[data-group]` element was rendered at. */

export interface GroupProps {
  id: string;
  label: ReactNode;
  /**
   * Plain-text group name for the `popup` button's face, its tooltip and the popover's
   * `aria-label`. Defaults to `label` when that is a string; pass it when `label` is JSX (a
   * `Badge`) or a long/dynamic caption ("Z Range · 12 levels").
   */
  name?: string;
  tier?: Tier;
  /** Declared full-tier width, used only by the dev-mode drift warning. */
  declaredWidth?: number;
  /** Dim + inert without unmounting, so neighbours never shift (the existing Home idiom). */
  dim?: boolean;
  /** Reason shown on the whole group while dimmed, and appended to the label. */
  dimNote?: ReactNode;
  children: ReactNode;
  /** Icon on the `popup` button. Defaults to a generic "more". */
  icon?: IconName;
  /**
   * The children draw their own narrow form at `popup` tier instead of collapsing behind a popup
   * button — MS guidance: a single-button group (the Block button) never becomes a popup icon,
   * it just narrows. `data-tier` still reads `popup`.
   */
  selfCollapsing?: boolean;
  style?: CSSProperties;
}

/**
 * Set inside a `popup` group's popover: running a command from it closes the popover (Office's
 * behaviour). Settings (sliders, segmented sets) don't call it, so tuning several stays one open.
 */
const PopupGroupCloseCtx = createContext<(() => void) | null>(null);
export function usePopupGroupClose(): (() => void) | null {
  return useContext(PopupGroupCloseCtx);
}
/** For other command-holding popovers that should behave the same (the compact ribbon's overflow »). */
export const PopupCloseProvider = PopupGroupCloseCtx.Provider;

export function Group({
  id, label, name, tier = "full", declaredWidth, dim, dimNote, children, icon = "more", selfCollapsing, style,
}: GroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const closePopup = useCallback(() => setPopupOpen(false), []);
  const popup = tier === "popup" && !selfCollapsing;

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
  // Only the `full` tier is checked: `medium` widths live solely in SPECS and are never handed to
  // a `Group`, and `popup` widths are fixed by construction (`POPUP_GROUP_W`).
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

  // A group that stops being a popup (window widened) mustn't leave its popover floating.
  const [prevPopup, setPrevPopup] = useState(popup);
  if (prevPopup !== popup) { setPrevPopup(popup); if (!popup) setPopupOpen(false); }

  if (popup) {
    const text = name ?? (typeof label === "string" ? label : id);
    const why = dim && typeof dimNote === "string" ? ` ${dimNote}` : "";
    return (
      <div ref={ref} data-group={id} data-tier={tier} style={{ ...groupShell, justifyContent: "flex-start", ...style }}>
        {/* `data-group-chevron`: ⌘K's reveal clicks it to open the popup a command lives in. */}
        <span data-group-chevron style={{ display: "contents" }}>
          <button
            className="rbn-btn" type="button" aria-label={text}
            title={dim ? `${text}${why}` : `${text} — show this group's commands`}
            aria-haspopup="dialog" aria-expanded={popupOpen}
            {...a11y(popupOpen, dim)}
            onClick={dim ? undefined : () => setPopupOpen(v => !v)}
            style={btnBase({
              width: POPUP_BTN_W, height: GROUP_CONTENT_H + GROUP_LABEL_H, padding: `${SPACE.md}px ${SPACE.xs}px ${SPACE.sm}px`,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: SPACE.sm,
              flexShrink: 0, ...stateStyle(popupOpen, dim),
            })}
          >
            {/* MS: a pop-up group icon is the group's most prominent command icon in a 32px container. */}
            <span aria-hidden="true" style={{
              width: 32, height: 32, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.md, background: SURFACE.well, boxShadow: `inset 0 0 0 1px ${HAIRLINE}`,
            }}>
              <Icon name={icon} size={20} tone={popupOpen ? "inherit" : "default"} />
            </span>
            <span style={{
              width: "100%", fontSize: FONT.label, lineHeight: "13px", textAlign: "center",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              overflowWrap: "anywhere",
            }}>{text}</span>
            <Icon name="split" size={ICON.xs} tone="inherit" />
          </button>
        </span>
        {popupOpen && (
          <Popover anchorRef={ref} onClose={closePopup} role="dialog" ariaLabel={text} autoFocus>
            <PopupGroupCloseCtx.Provider value={closePopup}>
              <div data-group-popup={id} style={{ ...groupShell, padding: `${SPACE.md}px ${SPACE.lg}px ${SPACE.sm}px` }}>
                <div style={groupBody}>{children}</div>
                <GroupLabel>{label}</GroupLabel>
              </div>
            </PopupGroupCloseCtx.Provider>
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-group={id}
      data-tier={tier}
      style={{ ...groupShell, ...(dim ? { opacity: 0.4 } : null), ...style }}
      aria-disabled={dim || undefined}
      title={dim && selfCollapsing && tier === "popup" && typeof dimNote === "string" ? dimNote : undefined}
    >
      {/* `inert` (not just pointerEvents:none) is what keeps a dimmed group's descendants out of
          the tab order — audit H7: pointerEvents only blocks the mouse, so a keyboard user could
          Tab into a dimmed group (e.g. Home's Selection/Set Point with nothing selected) and
          activate a command that has no target. */}
      <div style={{ ...groupBody, ...(dim ? { pointerEvents: "none" as const } : null) }} inert={dim || undefined}>{children}</div>
      <GroupLabel>
        {label}
        {/* A self-collapsed group is narrow on purpose — the note moves to the tooltip above. */}
        {dim && dimNote && tier !== "popup" ? <span style={{ color: TEXT_DIM, opacity: 0.9, marginLeft: SPACE.sm }}>{dimNote}</span> : null}
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

/** Large: 76px tall, icon over label. The mockup's primary commands (Paste, Pan, Delete, Fill…). */
export function LargeButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, badge, style, iconNode, keycap,
}: CommonBtn & { icon: IconName; iconNode?: ReactNode; keycap?: string }) {
  return (
    <button
      className="rbn-btn" type="button" title={title} aria-label={label} onClick={onClick}
      {...a11y(active, disabled)}
      style={btnBase({
        height: LARGE_H, minWidth: 54, padding: `${SPACE.md}px ${SPACE.md}px 5px`,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: SPACE.md, fontSize: FONT.body, lineHeight: "13px", position: "relative",
        color: tone === "danger" ? TEXT_DANGER : TEXT,
        ...stateStyle(active, disabled, accent),
        ...style,
      })}
    >
      {iconNode ?? <Icon name={icon} size={ICON.lg} tone={active ? "inherit" : TONE_ICON[tone]} />}
      <span style={{ maxWidth: 86, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {badge}
      {/* Keycap chip — `<Cmd>` (ribbon/Cmd.tsx) is the only caller that ever passes this, and only
          at `tier="full"`: small/medium rows carry the shortcut in their tooltip instead, per the
          plan's "keycaps on large buttons only". Absolutely positioned so it never affects the
          label's centring or the button's measured width (the drift guard/width harvester read the
          button's own rect, not this chip's). */}
      {keycap && (
        <span style={{ position: "absolute", top: 3, right: 3, pointerEvents: "none" }}>
          <Keycap text={keycap} small />
        </span>
      )}
    </button>
  );
}

/** A small `kbd` chip for a formatted chord (`formatChord`, `commands/keys.ts`). Shared by
 *  `LargeButton`'s corner chip, ⌘K's result rows and the top bar's search-shortcut hint — one
 *  implementation so the three never render a shortcut differently. */
export function Keycap({ text, small }: { text: string; small?: boolean }) {
  return (
    <kbd style={{
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: small ? FONT.micro : FONT.label,
      color: TEXT_DIM, background: SURFACE.well, border: `1px solid ${BORDER.hairline}`,
      borderRadius: RADIUS.sm, padding: small ? "0 3px" : "1px 5px", whiteSpace: "nowrap", lineHeight: 1.3,
    }}>{text}</kbd>
  );
}

/** Small: 24px tall, icon + label on one line. Everything secondary.
 *  `iconOnly` suppresses the visible label span but keeps `aria-label`/`title` at the full
 *  registry label, so the tooltip, ⌘K and Help stay unaffected — placement-only compaction. */
export function SmallButton({
  icon, label, title, onClick, active, disabled, tone = "default", accent, badge, style, full, iconOnly,
}: CommonBtn & { icon?: IconName; full?: boolean; iconOnly?: boolean }) {
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
      {!iconOnly && label && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>}
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
  tier = "full", iconNode, full, keycap, ...rest
}: CommonBtn & { icon: IconName; tier?: Tier; iconNode?: ReactNode; full?: boolean; keycap?: string }) {
  // Keycaps are a `full`-tier-only affordance (plan §5.7 step 3) — `SmallButton` never receives one,
  // even if a caller passes `keycap` regardless of tier, so this is the one place that's enforced.
  return tier === "full"
    ? <LargeButton {...rest} iconNode={iconNode} keycap={keycap} />
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
    <div ref={ref} data-no-cmd style={{ position: "relative", display: "flex" }}>
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
 * Nested-popover registry (Stage 15.4). Popovers are portaled to `<body>`, so a `Select`/split
 * menu opened *inside* another popover (every control in a `popup` group lives in one) is not a DOM
 * descendant of its parent panel — without this, the parent's outside-click listener saw a click
 * in the child menu as "outside", closed itself, and unmounted the child before the click landed.
 * Each popover registers its panel with every ancestor popover (portals keep React context).
 */
const PopoverNestCtx = createContext<((el: HTMLElement) => () => void) | null>(null);

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
  dismissDelayMs = 0, autoFocus = false,
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
  /** `listbox` gets the same roving keyboard model as `menu`, over `[role="option"]` rows, and
   *  opens with focus on the selected option (`Select`). */
  role?: "menu" | "dialog" | "listbox";
  ariaLabel?: string;
  style?: CSSProperties;
  /**
   * Delays registering the outside-click dismiss listener by this many ms (default 0, i.e. the
   * pre-existing immediate behaviour). Needed by `ContextMenu` (Stage 14.14): a right-click can
   * synthesize a trailing mousedown/mouseup on macOS WKWebView *after* the `contextmenu` event
   * that opened the menu, which would otherwise read as an immediate outside click and dismiss
   * the menu the instant it appears — the same 80ms guard the old hand-rolled context menu used.
   */
  dismissDelayMs?: number;
  /**
   * `role="dialog"` only: move focus to the panel's first enabled control on open (unless
   * something inside already has it — ⌘K's reveal focuses its target first) and hand it back to
   * the opener on close. Menus/listboxes always do this; a dialog opts in because the block
   * picker and the world pill own their own focus order.
   */
  autoFocus?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Panels of popovers opened from inside this one (and, transitively, theirs).
  const childPanels = useRef(new Set<HTMLElement>());
  const registerInParent = useContext(PopoverNestCtx);
  const registerChild = useCallback((el: HTMLElement) => {
    childPanels.current.add(el);
    const unregisterUp = registerInParent?.(el);
    return () => { childPanels.current.delete(el); unregisterUp?.(); };
  }, [registerInParent]);
  useLayoutEffect(() => {
    const el = panelRef.current;
    return el && registerInParent ? registerInParent(el) : undefined;
  }, [registerInParent]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /** Element focus should return to when the panel closes — captured before focus moves in. */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Stage 14.17: inside a `Dialog`, default above it (`dialogZIndex + 100`) instead of the flat 500
  // — retires the "pass zIndex 1100 inside a modal" manual convention. An explicit `style.zIndex`
  // below (Select's own `zIndex` prop) still wins.
  const dialogZ = useContext(DialogLayerContext);
  const defaultZIndex = dialogZ != null ? dialogZ + 100 : 500;

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
    const inside = (t: Node) => panelRef.current?.contains(t) || [...childPanels.current].some(c => c.contains(t));
    const down = (e: MouseEvent) => {
      if (inside(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      // A child popover is open: Escape is its to handle — one press closes one level.
      if (e.key === "Escape" && childPanels.current.size === 0) { e.stopPropagation(); (onEscape ?? onClose)(); }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (dismissDelayMs > 0) {
      timer = setTimeout(() => document.addEventListener("mousedown", down), dismissDelayMs);
    } else {
      document.addEventListener("mousedown", down);
    }
    window.addEventListener("keydown", key, true);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchorRef, onClose, onEscape, dismissDelayMs]);

  /**
   * Keyboard model for `role="menu"` panels (audit M2). Every opener already declares
   * `aria-haspopup="menu"` + `aria-expanded`, so assistive tech announced a menu that the keyboard
   * could not actually drive: focus never entered the panel, arrows did nothing, and closing it
   * dropped focus to the document body.
   *
   * Now: focus moves to the first enabled item on open, Up/Down/Home/End rove between items, Tab
   * closes the menu and lets focus continue past the opener (the ARIA menu convention — a menu is
   * not a dialog, so it traps nothing), and focus returns to whatever had it when the panel opened.
   * `role="dialog"` panels (the block picker, the world pill's details) are left alone: they own
   * their own inner focus order, and stealing it would break the pill's rename field.
   */
  // ⚠️ `onClose` is an inline arrow at almost every call site, so it changes identity on every
  // render of the parent. Depending on it directly would re-run the effect below constantly —
  // harmless for the listener above (it just re-registers), but here it would re-fire the
  // focus-first-item step and yank focus back to the top of the menu while the user was arrowing
  // through it. Read it through a ref instead and keep the effect keyed on `role` alone.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (role === "dialog" && autoFocus) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      const panel = panelRef.current;
      const raf = requestAnimationFrame(() => {
        if (panel?.contains(document.activeElement)) return;
        panel?.querySelector<HTMLElement>(
          'button:not([aria-disabled="true"]):not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )?.focus();
      });
      return () => {
        cancelAnimationFrame(raf);
        if (panel?.contains(document.activeElement)) returnFocusRef.current?.focus();
      };
    }
    if (role !== "menu" && role !== "listbox") return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    // Captured once: the panel node is stable for this effect's lifetime, and reading the ref in
    // the cleanup would read whatever it points at *after* unmount.
    const panel = panelRef.current;
    const itemRole = role === "menu" ? "menuitem" : "option";
    const items = () => Array.from(
      panel?.querySelectorAll<HTMLElement>(`[role="${itemRole}"]:not([aria-disabled="true"])`) ?? [],
    );
    // Defer one frame: the panel is portaled and positioned in a layout effect, so focusing before
    // that lands would scroll the page to the off-screen (-9999) staging position.
    const raf = requestAnimationFrame(() => {
      const list = items();
      (list.find(el => el.getAttribute("aria-selected") === "true") ?? list[0])?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (!panel?.contains(document.activeElement)) return;
      if (e.key === "Tab") { closeRef.current(); return; }
      const list = items();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
      else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next < 0) return;
      e.preventDefault();
      e.stopPropagation();
      list[next].focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      // Only reclaim focus if it's still inside the panel — a click elsewhere already moved it,
      // and yanking it back would fight the user.
      if (panel?.contains(document.activeElement)) returnFocusRef.current?.focus();
    };
  }, [role, autoFocus]);

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className="eden-ribbon vx-popover-enter"
      style={{
        background: SURFACE.popover,
        boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 10px 28px rgba(0,0,0,.6)`,
        borderRadius: RADIUS.lg,
        position: "fixed",
        top: pos?.top ?? -9999, left: pos?.left ?? -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: defaultZIndex, color: TEXT, fontSize: FONT.body,
        ...style,
      }}
    >
      <PopoverNestCtx.Provider value={registerChild}>{children}</PopoverNestCtx.Provider>
    </div>,
    document.body,
  );
}

// ── Composite controls ────────────────────────────────────────────────────────

/** Decimal places implied by a step value (0.1 → 1, 0.01 → 2, 1 → 0) — used to snap dragged/typed
 *  values to `step` without floating-point noise (e.g. 0.1 + 0.2 artefacts). */
function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * A labelled single-value slider — the ribbon's (and every modal's) one slider primitive. Draws
 * `RangeSlider`'s painted-track/thumb look with a single thumb, but — unlike `RangeSlider` — isn't
 * built on a real `<input type="range">`: the Windows field report (Stage 15.5) was that the native
 * element felt jumpy on a narrow track (0–255 over ~60px ≈ 4 levels/px), and the fix set below
 * (shift-drag fine mode, wheel/arrow stepping, a track-width floor) needs pointer-delta control a
 * native range element can't give mid-drag without fighting the browser's own drag algorithm.
 * Accessibility is hand-rolled instead (`role="slider"` + `aria-value*` + arrow/Home/End keys),
 * the standard ARIA slider pattern.
 *
 * Pointer model:
 *  - `pointerdown`: capture the pointer, jump straight to the clicked position (click-to-position,
 *    same as a native slider), and record that as the drag anchor.
 *  - `pointermove` **without** Shift: absolute — value tracks the pointer's position over the
 *    track, same as a native slider drag.
 *  - `pointermove` **with** Shift: relative — accumulates the pixel delta since the last move at
 *    1/4 rate, so a full track's width of travel only covers a quarter of the range (fine
 *    adjustment). Toggling Shift mid-drag re-anchors from the current pointer position, so there's
 *    no jump when the modifier changes.
 *  - `pointerup` / `pointercancel` / `lostpointercapture`: whichever fires first commits (via
 *    `onCommit`) and clears the drag state, so the others are no-ops — guards the WebView2 case
 *    where releasing the pointer outside the track can drop a plain `pointerup`.
 *  - Wheel and ←/→ (also ↑/↓) step by one `step` increment and commit immediately; Shift+wheel
 *    steps by ten. Home/End jump to `min`/`max`. These are discrete actions, not a drag, so each
 *    one calls `onChange` then `onCommit` in the same tick (no separate release step).
 *  - The value label is a click-to-type `NumField` unless `format` is given — `NumField` shows the
 *    raw number, so a slider with a custom display string (e.g. FlyView3D's non-linear
 *    render-distance mapping, or a "z=" prefix) keeps its old static formatted label instead of an
 *    editable field that would show the wrong number while typing.
 */
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
  const labelId = `${id}-label`;
  const trackRef = useRef<HTMLDivElement>(null);
  // Mirrors `value` on every onChange call so pointerup/lostpointercapture/pointercancel — whichever
  // fires first — commits what's actually shown, not a possibly-stale `value` prop (the parent's
  // re-render from the last onChange may not have landed by the time the pointer lifts).
  const latestRef = useRef(value);
  latestRef.current = value;
  const dragRef = useRef<{ pointerId: number; lastX: number; lastValue: number } | null>(null);

  const range = Math.max(1e-9, max - min);
  const decimals = stepDecimals(step);
  const snap = useCallback((v: number) => {
    const snapped = min + Math.round((v - min) / step) * step;
    const bounded = Math.min(max, Math.max(min, snapped));
    return decimals > 0 ? Number(bounded.toFixed(decimals)) : Math.round(bounded);
  }, [min, max, step, decimals]);

  // Track-width floor (the Windows sensitivity fix): at least 1px per step so a drag never has to
  // cross more than one pixel per level, floored at 96px and capped at 160px — past that a wide
  // slider (e.g. a 0–255 cutaway cap) buys no more usable precision than a mouse can place.
  const steps = step > 0 ? range / step : 0;
  const minTrackWidth = Math.max(96, Math.min(160, steps));
  const trackWidth = Math.max(width, minTrackWidth);

  const valueFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const pct = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return snap(min + pct * range);
  }, [min, range, snap, value]);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    onCommit?.(latestRef.current);
  }, [onCommit]);

  const pct = ((value - min) / range) * 100;
  const rgb = hexToRgbTriplet(accent);
  const thumbLeft = (pct / 100) * (trackWidth - 10);
  const maxDigits = String(Math.trunc(Math.max(Math.abs(min), Math.abs(max)))).length;
  const valueWidth = Math.max(26, 16 + maxDigits * 7 + (decimals > 0 ? (decimals + 1) * 7 : 0) + (min < 0 ? 6 : 0));

  return (
    <div title={title} style={{ display: "flex", alignItems: "center", gap: 5, height: SMALL_H, ...(disabled ? btnDisabled : null) }}>
      <label id={labelId} style={{ color: TEXT_DIM, fontSize: FONT.label, minWidth: labelWidth, userSelect: "none" }}>{label}</label>
      <div
        ref={trackRef}
        role="slider"
        aria-labelledby={labelId}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : String(value)}
        aria-disabled={disabled || undefined}
        aria-orientation="horizontal"
        tabIndex={disabled ? -1 : 0}
        style={{
          position: "relative", width: trackWidth, height: SMALL_H, flexShrink: 0,
          cursor: disabled ? "default" : "pointer", touchAction: "none",
        }}
        onPointerDown={e => {
          if (disabled) return;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const v = valueFromClientX(e.clientX);
          dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastValue: v };
          latestRef.current = v;
          onChange(v);
        }}
        onPointerMove={e => {
          const d = dragRef.current;
          if (!d || e.pointerId !== d.pointerId) return;
          let next: number;
          if (e.shiftKey) {
            const deltaPx = e.clientX - d.lastX;
            next = snap(d.lastValue + (deltaPx / trackWidth) * range * 0.25);
          } else {
            next = valueFromClientX(e.clientX);
          }
          d.lastX = e.clientX;
          d.lastValue = next;
          latestRef.current = next;
          onChange(next);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onWheel={e => {
          if (disabled) return;
          e.preventDefault();
          const dir = e.deltaY < 0 ? 1 : -1;
          const next = snap(value + dir * (e.shiftKey ? step * 10 : step));
          onChange(next);
          onCommit?.(next);
        }}
        onKeyDown={e => {
          if (disabled) return;
          let next: number | null = null;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") next = snap(value + step);
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = snap(value - step);
          else if (e.key === "Home") next = min;
          else if (e.key === "End") next = max;
          if (next == null) return;
          e.preventDefault();
          onChange(next);
          onCommit?.(next);
        }}
      >
        <div aria-hidden="true" style={{
          position: "absolute", top: 11, left: 4, right: 4, height: 4, borderRadius: RADIUS.sm,
          pointerEvents: "none", boxShadow: `inset 0 0 0 1px ${BORDER.outline}`,
          background: `linear-gradient(to right, rgb(${rgb}) 0%, rgb(${rgb}) ${pct}%, ${SURFACE.well} ${pct}%, ${SURFACE.well} 100%)`,
        }} />
        <div aria-hidden="true" style={{
          position: "absolute", top: 7, left: thumbLeft, width: 10, height: 10, borderRadius: "50%",
          pointerEvents: "none", background: `rgb(${rgb})`,
          boxShadow: `0 0 0 1px ${BORDER.outline}, inset 0 1px 0 rgba(255,255,255,.35)`,
        }} />
      </div>
      {!disabled && !format ? (
        <NumField
          value={value} min={min} max={max} width={valueWidth} ariaLabel={`${label} value`}
          onChange={v => { const n = snap(v); onChange(n); onCommit?.(n); }}
          style={{ height: 18, fontSize: FONT.label, padding: "0 3px" }}
        />
      ) : (
        <span style={{ color: TEXT, fontSize: FONT.label, fontVariantNumeric: "tabular-nums", minWidth: 26, textAlign: "right" }}>
          {format ? format(value) : value}
        </span>
      )}
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

  // Thumb centre tracks `pct` of the *travel* range (width minus the thumb's own diameter), not
  // the full container width — otherwise the leftmost thumb's centre sits at x=0 and half its
  // 10px circle renders past the container's left edge, clipped by any ancestor's overflow.
  const thumb = (pct: number, bright: boolean): CSSProperties => ({
    position: "absolute", top: 8, left: (pct / 100) * (width - 10), width: 10, height: 10,
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
/**
 * Radio-style row of small buttons.
 *
 * Keyboard model per the ARIA radiogroup pattern (audit M2): the group is **one** tab stop, not
 * one per option — only the checked option is tabbable — and Left/Right/Up/Down move the selection
 * (and focus) to the adjacent option, wrapping, with Home/End jumping to the ends. Before this,
 * every option sat in the tab order and none of the arrow keys did anything, so a five-option
 * group cost five Tab presses to walk past and could not be changed from the keyboard at all.
 */
export function Segmented<T extends string>({
  label, value, options, onChange, accent, ariaLabel,
}: {
  label?: string; value: T; ariaLabel: string;
  options: { id: T; label: string; title?: string; icon?: IconName }[];
  onChange: (v: T) => void; accent?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const move = (from: number, key: string) => {
    const n = options.length;
    let to = -1;
    if (key === "ArrowRight" || key === "ArrowDown") to = (from + 1) % n;
    else if (key === "ArrowLeft" || key === "ArrowUp") to = (from - 1 + n) % n;
    else if (key === "Home") to = 0;
    else if (key === "End") to = n - 1;
    if (to < 0) return false;
    onChange(options[to].id);
    // Focus follows selection, which is what makes repeated arrow presses keep working.
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
    return true;
  };
  // A group whose value isn't one of its options (shouldn't happen, but a stale prop would do it)
  // must still have exactly one tab stop, or it drops out of the tab order entirely.
  const checkedIndex = Math.max(0, options.findIndex(o => o.id === value));
  return (
    <div ref={groupRef} role="radiogroup" aria-label={ariaLabel} style={{ display: "flex", alignItems: "center", gap: COL_GAP, height: SMALL_H }}>
      {label && <FieldLabel>{label}</FieldLabel>}
      {options.map((o, idx) => (
        <button
          key={o.id} role="radio" aria-checked={value === o.id} className="rbn-btn" type="button"
          tabIndex={idx === checkedIndex ? 0 : -1}
          onKeyDown={e => { if (move(idx, e.key)) { e.preventDefault(); e.stopPropagation(); } }}
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
        // The current option is pushed in (Stage 14.2), not armed-accent: a menu row is a list
        // item, and "current" has one look app-wide.
        ...(active ? currentRow() : null),
        ...(disabled ? btnDisabled : null),
      })}
    >
      {icon && <Icon name={icon} size={ICON.sm} tone={danger ? "danger" : active ? "inherit" : "default"}
        style={active ? { color: CUR_ICON } : undefined} />}
      <span style={{ flex: 1 }}>{label}</span>
      {shortcut && <span style={{ fontSize: FONT.micro, color: TEXT_LABEL }}>{shortcut}</span>}
    </button>
  );
}

/**
 * A dropdown that picks one value (Stage 14.2) — the primitive native `<select>`s move onto
 * (Settings ▸ Sounds' pack, Prefab sort, the picker's Expansion sub-type).
 *
 * Button + portaled `Popover` listbox, reusing the Popover's keyboard model: ↓ / Enter / Space on
 * the button opens it with focus on the current option, arrows/Home/End move, Enter picks, Escape
 * and Tab close. The current option is **pushed in** with a check icon (the current-item recipe).
 * Inside a `Dialog` (`src/ui/Dialog.tsx`) the listbox defaults above it automatically via
 * `DialogLayerContext` — an explicit `zIndex` prop is only needed to override that.
 */
export function Select<T extends string>({
  value, options, onChange, ariaLabel, width = 170, disabled, zIndex, title,
}: {
  value: T; ariaLabel: string;
  options: { id: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  width?: number; disabled?: boolean; zIndex?: number; title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.id === value);
  const pick = (id: T) => {
    setOpen(false);
    if (id !== value) onChange(id);
    btnRef.current?.focus();
  };
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", width }}>
      <button
        ref={btnRef} type="button" className="rbn-btn" title={title ?? ariaLabel}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); }
        }}
        {...a11y(false, disabled)}
        style={btnBase({
          width: "100%", height: SMALL_H, padding: "0 6px 0 8px", display: "flex", alignItems: "center",
          gap: SPACE.sm, justifyContent: "space-between", ...(disabled ? btnDisabled : null),
        })}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{current?.label ?? value}</span>
        <Icon name="split" size={ICON.xs} tone="inherit" />
      </button>
      {open && (
        <Popover anchorRef={ref} onClose={() => setOpen(false)} role="listbox" ariaLabel={ariaLabel}
          style={{ padding: SPACE.sm, minWidth: width, ...(zIndex != null ? { zIndex } : null) }}>
          {/* Capped + scrollable so a long list (the Draw mask's block/paint pickers) can't outgrow the
              viewport; the short lists every earlier caller passes never reach the cap. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: "min(320px, 60vh)", overflowY: "auto" }}>
            {options.map(o => {
              const cur = o.id === value;
              return (
                <button
                  key={o.id} type="button" role="option" aria-selected={cur} className="rbn-btn"
                  title={o.title} data-active={cur ? "true" : undefined}
                  onClick={() => pick(o.id)}
                  style={btnBase({
                    display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left",
                    padding: `0 ${SPACE.lg}px`, height: 26, background: "none", boxShadow: "none",
                    ...(cur ? currentRow() : null),
                  })}
                >
                  <span style={{ width: ICON.sm, display: "flex" }}>
                    {cur && <Icon name="check" size={ICON.sm} tone="inherit" style={{ color: CUR_ICON }} />}
                  </span>
                  <span style={{ flex: 1 }}>{o.label}</span>
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}

// ── Small shared parts ────────────────────────────────────────────────────────

const BADGE_TONE: Record<"exp" | "perf" | "ok", { fg: string; rgb: string; text: string; title: string }> = {
  exp: { fg: RAMP.badgeExp, rgb: hexToRgbTriplet(ACCENT.warm), text: "exp", title: "Experimental" },
  perf: { fg: TEXT_DANGER, rgb: hexToRgbTriplet(DANGER), text: "⚡", title: "Performance-intensive" },
  ok: { fg: RAMP.badgeOk, rgb: hexToRgbTriplet(ACCENT.clipboard), text: "✓", title: "" },
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

/**
 * Labelled checkbox. Replaces raw `<input type="checkbox" style={{accentColor:"#3b82f6"}}>`.
 *
 * `hint` (optional) adds a second, dimmer line under the label — the app menu's "Save compressed /
 * what that means" rows. With a hint the row is top-aligned and grows to fit instead of holding the
 * fixed `SMALL_H` height; without one nothing changes.
 */
export function Check({
  checked, onChange, label, title, disabled, hint, indeterminate,
}: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string; disabled?: boolean;
  hint?: ReactNode;
  /** The mixed state (some-but-not-all): drawn as a dash, and a click still reports `!checked`. */
  indeterminate?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label title={title} className="vx-chk" style={{
      display: "flex", alignItems: hint ? "flex-start" : "center", gap: 5, height: hint ? undefined : SMALL_H,
      userSelect: "none",
      cursor: disabled ? "default" : "pointer", ...(disabled ? btnDisabled : null),
    }}>
      {/* The native input stays (visually hidden, `.vx-chk-in`) for keyboard, focus and screen
          readers; the box next to it is what's drawn. Styles: theme/cssVars.ts. */}
      <span className="vx-chk-wrap" style={{ marginTop: hint ? 2 : 0 }}>
        <input ref={inputRef} type="checkbox" className="vx-chk-in" data-no-focus-ring
          checked={checked} disabled={disabled}
          onChange={e => onChange(e.target.checked)} />
        <span className="vx-chk-box" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path className="vx-chk-tick" d="M3.4 7.4l2.4 2.4 4.8-5.2" />
            <path className="vx-chk-dash" d="M3.8 7h6.4" />
          </svg>
        </span>
      </span>
      {hint ? (
        <span>
          <span style={{ color: TEXT_DIM, fontSize: FONT.label }}>{label}</span>
          <span style={{ display: "block", color: TEXT_META, fontSize: FONT.label, lineHeight: 1.45 }}>{hint}</span>
        </span>
      ) : (
        <span style={{ color: TEXT_DIM, fontSize: FONT.label }}>{label}</span>
      )}
    </label>
  );
}
