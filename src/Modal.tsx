import { useEffect, useRef, type RefObject } from "react";
import { glassBackdrop } from "./designTokens";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Stacking order; modals opened over other modals pass a higher value. */
  zIndex?: number;
  /** id of the element that titles the dialog (→ aria-labelledby). */
  labelledBy?: string;
  /** Accessible name when there is no visible title element. */
  label?: string;
  /** Set false to disable backdrop-click dismissal (e.g. mid-operation modals). */
  closeOnBackdrop?: boolean;
  /** Set false to disable Escape-to-close (e.g. while a long op is running). */
  closeOnEsc?: boolean;
  /** Extra backdrop styles (e.g. a darker `background`); merged over glassBackdrop. */
  backdropStyle?: React.CSSProperties;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus trap + initial focus for a dialog-like panel, without Modal's full-screen backdrop.
 * Shared by Modal (below) and any non-modal dockable panel that still wants real keyboard a11y
 * (e.g. PrefabLibraryPanel — a floating panel meant to coexist with the map, not block it, so it
 * can't use Modal's centered/backdropped shell, but the Tab-cycling logic is identical and
 * fiddly enough to be worth not re-deriving).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, focusOnMount = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (focusOnMount) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || active === el)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [ref, focusOnMount]);
}

/**
 * Shared modal shell (Q4): one backdrop, Escape-to-close, focus trap, initial
 * focus, and `role="dialog"` ARIA for every modal. Children provide their own
 * `glassPanel` — Modal only owns the backdrop + a11y behaviours.
 */
export default function Modal({
  onClose,
  children,
  zIndex = 9000,
  labelledBy,
  label,
  closeOnBackdrop = true,
  closeOnEsc = true,
  backdropStyle,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  // Escape-to-close. Registered on the panel so nested modals (higher zIndex) don't double-handle
  // a single keypress.
  useEffect(() => {
    const el = panelRef.current;
    if (!el || !closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [onClose, closeOnEsc]);

  return (
    <div
      style={{ ...glassBackdrop, zIndex, ...backdropStyle }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        style={{ outline: "none", display: "flex" }}
      >
        {children}
      </div>
    </div>
  );
}
