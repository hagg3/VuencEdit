import type { CSSProperties, ReactNode } from "react";
import ErrorBoundary from "./ErrorBoundary";
import Dialog, { DialogButton } from "./ui/Dialog";
import { RAMP } from "./theme/theme";
import { btnBase } from "./ribbon/tokens";

/**
 * Per-piece error containment (21.15). A throw inside the wrapped subtree is replaced by a small
 * in-place fallback instead of unmounting the whole app.
 *  - `chip`   floating windows / hotbar / lens / context panels: a compact corner chip with
 *             Retry and Close (Close hides it; the window's own toggle brings it back).
 *  - `dock`   the sidebar: the same chip, fixed under the ribbon at the right edge.
 *  - `dialog` modals: a small `Dialog` with Retry and Close (`onClose` closes the real dialog).
 * Never wrap a Reparentable viewport's InPortal content here (a wrapper that remounts would defeat
 * it); wrap only the window frames / hosts around them.
 */
interface Props {
  label: string;
  kind?: "chip" | "dock" | "dialog";
  /** Dialogs: close the underlying dialog. Chips: also called on Close, after hiding. */
  onClose?: () => void;
  /** Chip stacking slot (0..n) so several failed windows do not overlap. */
  slot?: number;
  /** Dock: top inset in px (ribbon height). */
  topPx?: number;
  children: ReactNode;
}

const chipBtn = btnBase({ padding: "0 8px", height: 22 });

export function FailureChip(
  { label, message, onRetry, onClose, style }:
  { label: string; message: string; onRetry: () => void; onClose: () => void; style?: CSSProperties },
) {
  return (
    <div role="alert" style={{
      position: "absolute", display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
      maxWidth: 360, boxSizing: "border-box", background: RAMP.chrome, color: RAMP.dim,
      fontSize: 11, borderRadius: 6, pointerEvents: "auto", zIndex: 30,
      boxShadow: "0 0 0 1px var(--vx-border-outline)", ...style,
    }}>
      <span style={{ color: RAMP.textDanger, fontWeight: 600, flexShrink: 0 }}>{label} failed</span>
      <span title={message} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: RAMP.meta, minWidth: 0 }}>
        {message}
      </span>
      <button type="button" className="rbn-btn" onClick={onRetry} style={chipBtn}>Retry</button>
      <button type="button" className="rbn-btn" onClick={onClose} style={chipBtn}>Close</button>
    </div>
  );
}

export default function PanelBoundary({ label, kind = "chip", onClose, slot = 0, topPx = 0, children }: Props) {
  return (
    <ErrorBoundary label={label} fallback={(error, retry, dismiss) => {
      const message = error.message || String(error);
      if (kind === "dialog") {
        return (
          <Dialog size="sm" icon="warning" title={`${label} failed`} onClose={() => onClose?.()}
            footer={<>
              <DialogButton onClick={retry}>Retry</DialogButton>
              <DialogButton variant="primary" onClick={() => onClose?.()}>Close</DialogButton>
            </>}>
            <div style={{ wordBreak: "break-word" }}>{message}</div>
          </Dialog>
        );
      }
      const close = () => { dismiss(); onClose?.(); };
      const pos: CSSProperties = kind === "dock"
        ? { position: "fixed", top: topPx + 8, right: 8, zIndex: 130 }
        : { left: 8, bottom: 8 + slot * 30 };
      return <FailureChip label={label} message={message} onRetry={retry} onClose={close} style={pos} />;
    }}>
      {children}
    </ErrorBoundary>
  );
}
