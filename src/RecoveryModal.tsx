import { useState } from "react";
import { MODAL_TEXT } from "./designTokens";
import { DANGER_HEX, RAMP, mix } from "./theme/theme";
import Dialog, { DialogButton } from "./ui/Dialog";

/** Lightened danger tint for text on the warm modal surface (mechanical hex-literal migration,
 *  Stage 14.15) — plain `DANGER_HEX` fails AA there. */
const RED_LIGHT = mix(RAMP.white, DANGER_HEX, 0.5);
import type { AutosaveInfo } from "./types";

function timeAgoShort(unixSeconds: number): string {
  const secs = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (secs < 60) return "moments ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * ⚠️ Escape / backdrop-click must NOT destroy the autosave (they call `onDismiss`, which only
 * closes the dialog and leaves the sidecar on disk to be re-offered next launch). Deleting the
 * only copy of the user's unsaved work is reserved for the explicit Discard button, behind a
 * confirm step — this is the one dialog whose entire job is protecting that work.
 */
export default function RecoveryModal({
  info, recovering, onRecover, onDiscard, onDismiss, onOpenBase,
}: {
  info: AutosaveInfo;
  recovering: boolean;
  onRecover: () => void;
  /** Permanently deletes the autosave sidecar. Only ever reached via Discard → Confirm. */
  onDiscard: () => void;
  /** Closes the dialog, keeping the sidecar. Esc, backdrop, and "Not now". */
  onDismiss: () => void;
  /** `base_status === "changed"` only: drop the stale autosave and open the world file instead. */
  onOpenBase: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const when = timeAgoShort(info.timestamp);
  // 18.9: a format-2 autosave can build on the user's world file. If that file moved or changed
  // since, recovery would refuse, so say why up front.
  const status = info.base_status ?? "ok";
  const basePath = info.base?.kind === "source" ? info.base.path : null;
  const baseName = basePath?.split(/[\\/]/).pop() ?? "The world file";

  const footer = confirmDiscard ? (
    <>
      <DialogButton onClick={() => setConfirmDiscard(false)} disabled={recovering}>Keep</DialogButton>
      <DialogButton variant="danger" onClick={onDiscard} disabled={recovering}>Delete autosave</DialogButton>
    </>
  ) : (
    <>
      <DialogButton onClick={onDismiss} disabled={recovering}>Not now</DialogButton>
      <DialogButton onClick={() => setConfirmDiscard(true)} disabled={recovering}>Discard</DialogButton>
      {status === "changed" ? (
        <DialogButton variant="primary" onClick={onOpenBase} disabled={recovering}>Open file</DialogButton>
      ) : (
        <DialogButton variant="primary" onClick={onRecover} disabled={recovering}>
          {recovering ? "Recovering…" : status === "missing" ? "Try again" : "Recover"}
        </DialogButton>
      )}
    </>
  );

  return (
    <Dialog
      size="sm" icon="history" title="Recover unsaved work?" onClose={onDismiss} busy={recovering}
      footer={footer}
    >
      <p style={{ margin: "0 0 8px", color: MODAL_TEXT.secondary, lineHeight: 1.5 }}>
        VuencEdit found autosaved changes from a previous session that wasn't saved before closing.
      </p>
      <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 6, padding: "8px 12px", margin: "0 0 16px", fontFamily: "monospace", fontSize: 12 }}>
        <div><span style={{ color: MODAL_TEXT.label }}>World: </span>{info.world_name || "(unnamed)"}</div>
        <div><span style={{ color: MODAL_TEXT.label }}>Autosaved: </span>{when}</div>
        {info.source_path && <div style={{ color: MODAL_TEXT.label, wordBreak: "break-all" }}>{info.source_path}</div>}
      </div>
      {status === "changed" && !confirmDiscard && (
        <p style={{ margin: "0 0 8px", color: MODAL_TEXT.secondary, lineHeight: 1.5 }}>
          {baseName} was saved or changed after this autosave, so the autosave no longer applies. Open the file instead.
        </p>
      )}
      {status === "missing" && !confirmDiscard && (
        <p style={{ margin: "0 0 8px", color: MODAL_TEXT.secondary, lineHeight: 1.5 }}>
          This autosave needs the world file it was made from, which isn't at {basePath ?? "its saved location"}. Put it back or reconnect its drive, then try again.
        </p>
      )}
      {confirmDiscard && (
        <p style={{ margin: 0, color: RED_LIGHT, lineHeight: 1.5 }}>
          Permanently delete the autosave from {when}? This can't be undone.
        </p>
      )}
    </Dialog>
  );
}
