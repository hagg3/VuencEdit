/**
 * The shared dialog chrome (UI redesign r3, Stage 14.17 — `TEST WORLDS/ui-redesign-r3-modals-plan-
 * 2026-09-27.md` §3.2). Wraps `Modal` (backdrop, focus trap, Esc, `role="dialog"` — unchanged) and
 * owns everything visual: a fixed-size frame (`dialogFrame`, never content-driven), a 32px title
 * bar borrowing `windows/FloatingWindow.tsx`'s gradient recipe and CSS var tokens (not the windows
 * framework itself — see the plan's §3.1 "wrong layer/persistence/modality" reasoning), an optional
 * `DialogNav` side column, a scrolling body, and an optional fixed 48px footer.
 *
 * Deliberately does **not** import anything from `src/windows/` — a dialog can open before any
 * world (and therefore any window layout) exists, e.g. `AboutModal` from the splash screen.
 */
import {
  createContext, useId, useSyncExternalStore, type CSSProperties, type ReactNode,
} from "react";
import Modal from "../Modal";
import { Icon, type IconName } from "../ribbon/icons";
import {
  ACCENT, DANGER, FONT, ICON, RADIUS, TEXT_META, btnBase, btnDisabled,
} from "../ribbon/tokens";
import { MODAL_TEXT_ROLES, armedRecipe } from "../theme/theme";
import { v } from "../theme/cssVars";
import { dialogFrame, type DialogSize } from "./dialogSize";

const MODAL_TEXT = MODAL_TEXT_ROLES;

const TITLE_H = 32;
const FOOTER_H = 48;

/** The dialog's own stacking zIndex, read by `Popover`/`Select` (`ribbon/primitives.tsx`) so a
 *  dropdown opened from inside a dialog defaults above it without every call site passing its own
 *  `zIndex`. `null` outside any dialog (the pre-existing default). */
export const DialogLayerContext = createContext<number | null>(null);

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
function getWidth() { return window.innerWidth; }
function getHeight() { return window.innerHeight; }

/** The one viewport-size read in this file — `useSyncExternalStore` over `window`'s own resize
 *  event, the same idiom `windows/useWindowLayout.ts` uses for its (app-owned) store. */
function useViewportSize(): { w: number; h: number } {
  const w = useSyncExternalStore(subscribeResize, getWidth, getWidth);
  const h = useSyncExternalStore(subscribeResize, getHeight, getHeight);
  return { w, h };
}

const DIALOG_CSS = `
.vx-dlg-x { width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center; background: transparent;
  color: var(--vx-modal-text-secondary); border-radius: ${RADIUS.sm}px; }
.vx-dlg-x:hover:not(:disabled) { background: rgba(255,255,255,.08); color: var(--vx-modal-text-primary); }
.vx-dlg-x:active:not(:disabled) { background: rgba(0,0,0,.2); }
.vx-dlg-x:disabled { opacity: .4; cursor: default; }
.vx-dlg-btn:hover:not(:disabled) { filter: brightness(1.08); }
.vx-dlg-btn:active:not(:disabled) { filter: brightness(0.9); }
.vx-dlg-btn:disabled { opacity: .5; cursor: default; }
:root[data-motion="full"] .vx-dlg-panel { animation: vxDialogIn 150ms cubic-bezier(0.16,1,0.3,1) both; }
@keyframes vxDialogIn { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
`;

export interface DialogProps {
  size: DialogSize;
  icon: IconName;
  title: string;
  meta?: ReactNode;
  onClose: () => void;
  /** Disables backdrop-click, Esc, and the ✕ — the existing "can't dismiss mid-operation" convention. */
  busy?: boolean;
  /** A `DialogNav` element, or omitted/null for a dialog with no side navigation. */
  nav?: ReactNode;
  /** Fixed 48px bottom strip with a top hairline: right-aligned actions + an optional left slot. */
  footer?: ReactNode;
  zIndex?: number;
  labelledBy?: string;
  label?: string;
  children: ReactNode;
}

export default function Dialog({
  size, icon, title, meta, onClose, busy, nav, footer, zIndex = 1000, labelledBy, label, children,
}: DialogProps) {
  const { w: vw, h: vh } = useViewportSize();
  const frame = dialogFrame(size, vw, vh);
  const autoId = useId();
  const titleId = label ? undefined : (labelledBy ?? `dlg-title-${autoId}`);

  return (
    <Modal
      onClose={onClose} zIndex={zIndex} labelledBy={titleId} label={label}
      closeOnBackdrop={false} closeOnEsc={!busy}
    >
      <style>{DIALOG_CSS}</style>
      <div
        className="vx-dlg-panel"
        style={{
          width: frame.w, height: frame.h, maxHeight: frame.h == null ? vh - 48 : undefined,
          display: "flex", flexDirection: "column", minHeight: 0,
          background: v("surface-modal"),
          borderRadius: RADIUS.lg,
          boxShadow: `${v("pop-shadow")}, inset 0 0 0 1px ${v("border-outline")}, inset 0 1px 0 ${v("border-bevel")}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: TITLE_H, flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
            padding: "0 8px 0 12px",
            background: v("surface-modal"),
            backgroundImage: "linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,0))",
            boxShadow: `inset 0 -1px 0 ${v("border-outline")}, inset 0 1px 0 ${v("border-bevel")}`,
          }}
        >
          <span style={{ display: "flex", flexShrink: 0 }}><Icon name={icon} size={ICON.sm} tone="default" /></span>
          <span id={titleId} style={{
            color: MODAL_TEXT.primary, fontSize: FONT.tab, fontWeight: 600,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {title}
          </span>
          {meta != null && (
            <span style={{ color: TEXT_META, fontSize: FONT.label, overflow: "hidden", textOverflow: "ellipsis" }}>
              {meta}
            </span>
          )}
          <span style={{ flex: 1, minWidth: 0 }} />
          <button
            type="button" className="vx-dlg-x" onClick={onClose} disabled={busy}
            aria-label={`Close ${title}`} title={busy ? "Working…" : `Close ${title}`}
          >
            <Icon name="close" size={ICON.xs} tone="inherit" />
          </button>
        </div>

        <DialogLayerContext.Provider value={zIndex}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
            {nav}
            <div
              style={{
                flex: 1, minWidth: 0, minHeight: 0, overflow: "auto",
                padding: "16px 20px", color: MODAL_TEXT.primary, fontSize: FONT.body,
              }}
            >
              {children}
            </div>
          </div>
          {footer && (
            <div style={{
              height: FOOTER_H, flexShrink: 0, display: "flex", alignItems: "center",
              // Right-aligned by default. A caller wanting a left slot (e.g. Settings' "Reset to
              // defaults") gives that element `style={{ marginRight: "auto" }}` — no dedicated
              // slot component, since most footers are a plain right-aligned button row.
              justifyContent: "flex-end", gap: 8, padding: "0 16px",
              boxShadow: `inset 0 1px 0 ${v("border-modalHairline")}`,
            }}>
              {footer}
            </div>
          )}
        </DialogLayerContext.Provider>
      </div>
    </Modal>
  );
}

export type DialogButtonVariant = "neutral" | "primary" | "danger";

const VARIANT_ACCENT: Record<DialogButtonVariant, string | null> = {
  neutral: null, primary: ACCENT.primary, danger: DANGER,
};

export function DialogButton({
  variant = "neutral", onClick, disabled, title, type = "button", style, children,
}: {
  variant?: DialogButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  style?: CSSProperties;
  children: ReactNode;
}) {
  const accent = VARIANT_ACCENT[variant];
  const armed = accent ? armedRecipe(accent) : null;
  return (
    <button
      type={type} className="vx-dlg-btn" onClick={onClick} disabled={disabled} title={title}
      style={btnBase({
        height: 28, padding: "0 16px", fontSize: FONT.body, fontWeight: 600,
        color: armed ? armed.text : MODAL_TEXT.primary,
        // Neutral buttons sit on the warm modal surface, not the ribbon's cool slate — `btnBase`'s
        // default `SURFACE.raised` would be a third, unrelated material here (the same trap
        // `designTokens.ts`'s old `chromeButton` comment warns about), so the raised face is the
        // modal ramp's own (`surface-modalRaised`).
        ...(armed
          ? { background: armed.bg, boxShadow: armed.shadow, textShadow: "0 1px 0 rgba(0,0,0,.35)" }
          : { background: v("surface-modalRaised"), boxShadow: `inset 0 0 0 1px ${v("border-outline")}, inset 0 1px 0 ${v("border-bevel")}` }),
        ...(disabled ? btnDisabled : null),
        ...style,
      })}
    >
      {children}
    </button>
  );
}
