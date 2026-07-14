import { useState } from "react";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, chromeButton, chromeButtonAccent } from "./designTokens";
import Modal from "./Modal";
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
  info, recovering, onRecover, onDiscard, onDismiss,
}: {
  info: AutosaveInfo;
  recovering: boolean;
  onRecover: () => void;
  /** Permanently deletes the autosave sidecar. Only ever reached via Discard → Confirm. */
  onDiscard: () => void;
  /** Closes the dialog, keeping the sidecar. Esc, backdrop, and "Not now". */
  onDismiss: () => void;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const modal = glassPanel({
    padding: "22px 26px", minWidth: 380, maxWidth: 460,
    color: "#ebe9e7", fontSize: 13,
  });
  const when = timeAgoShort(info.timestamp);
  return (
    <Modal onClose={onDismiss} zIndex={9500} labelledBy="recovery-title" closeOnEsc={!recovering} closeOnBackdrop={!recovering}>
      <div style={modal}>
        <h2 id="recovery-title" style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: EDEN_TEAL_READABLE }}>
          Recover unsaved work?
        </h2>
        <p style={{ margin: "0 0 8px", color: "#dad6d2", lineHeight: 1.5 }}>
          Eden World Editor found autosaved changes from a previous session that wasn't saved before closing.
        </p>
        <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 6, padding: "8px 12px", margin: "0 0 16px", fontFamily: "monospace", fontSize: 12 }}>
          <div><span style={{ color: "#83786c" }}>World: </span>{info.world_name || "(unnamed)"}</div>
          <div><span style={{ color: "#83786c" }}>Autosaved: </span>{when}</div>
          {info.source_path && <div style={{ color: "#83786c", wordBreak: "break-all" }}>{info.source_path}</div>}
        </div>
        {confirmDiscard && (
          <p style={{ margin: "0 0 12px", color: "#f0a97f", lineHeight: 1.5 }}>
            Permanently delete the autosave from {when}? This can't be undone.
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          {confirmDiscard ? (
            <>
              <button
                onClick={() => setConfirmDiscard(false)}
                disabled={recovering}
                style={chromeButton({ padding: "8px 16px", fontSize: 13, opacity: recovering ? 0.5 : 1 })}
              >
                Keep
              </button>
              <button
                onClick={onDiscard}
                disabled={recovering}
                style={chromeButtonAccent("224,104,74", "#f0a97f", { padding: "8px 16px", fontSize: 13, color: "#f0a97f", fontWeight: 600, opacity: recovering ? 0.5 : 1 })}
              >
                Delete autosave
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onDismiss}
                disabled={recovering}
                style={chromeButton({ padding: "8px 16px", fontSize: 13, opacity: recovering ? 0.5 : 1 })}
              >
                Not now
              </button>
              <button
                onClick={() => setConfirmDiscard(true)}
                disabled={recovering}
                style={chromeButton({ padding: "8px 16px", fontSize: 13, opacity: recovering ? 0.5 : 1 })}
              >
                Discard
              </button>
              <button
                onClick={onRecover}
                disabled={recovering}
                style={chromeButtonAccent(EDEN_TEAL, EDEN_TEAL_READABLE, { padding: "8px 16px", fontSize: 13, color: EDEN_TEAL_READABLE, fontWeight: 600, opacity: recovering ? 0.7 : 1 })}
              >
                {recovering ? "Recovering…" : "Recover"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
