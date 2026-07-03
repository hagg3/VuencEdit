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

export default function RecoveryModal({
  info, recovering, onRecover, onDiscard,
}: {
  info: AutosaveInfo;
  recovering: boolean;
  onRecover: () => void;
  onDiscard: () => void;
}) {
  const modal = glassPanel({
    padding: "22px 26px", minWidth: 380, maxWidth: 460,
    color: "#e2e8f0", fontSize: 13,
  });
  return (
    <Modal onClose={onDiscard} zIndex={9500} labelledBy="recovery-title" closeOnEsc={!recovering} closeOnBackdrop={!recovering}>
      <div style={modal}>
        <h2 id="recovery-title" style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: EDEN_TEAL_READABLE }}>
          Recover unsaved work?
        </h2>
        <p style={{ margin: "0 0 8px", color: "#cbd5e1", lineHeight: 1.5 }}>
          Eden World Editor found autosaved changes from a previous session that wasn't saved before closing.
        </p>
        <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 6, padding: "8px 12px", margin: "0 0 16px", fontFamily: "monospace", fontSize: 12 }}>
          <div><span style={{ color: "#64748b" }}>World: </span>{info.world_name || "(unnamed)"}</div>
          <div><span style={{ color: "#64748b" }}>Autosaved: </span>{timeAgoShort(info.timestamp)}</div>
          {info.source_path && <div style={{ color: "#64748b", wordBreak: "break-all" }}>{info.source_path}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onDiscard}
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
        </div>
      </div>
    </Modal>
  );
}
