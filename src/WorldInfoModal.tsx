import { EDEN_TEAL_READABLE, glassPanel } from "./designTokens";
import Modal from "./Modal";
import WorldInfoPanel from "./panels/WorldInfoPanel";

/**
 * Thin `Modal` wrapper around `WorldInfoPanel` — the same content the application menu's
 * Properties pane renders, so the two can't drift.
 */
export default function WorldInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} zIndex={9000} labelledBy="worldinfo-title">
      <div style={glassPanel({
        padding: "20px 24px", minWidth: 440, maxWidth: 540, maxHeight: "85vh",
        overflowY: "auto", color: "#ebe9e7", fontSize: 12,
      })}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 id="worldinfo-title" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: EDEN_TEAL_READABLE }}>
            World Info
          </h2>
          <button onClick={onClose} aria-label="Close"
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#83786c")}
            style={{ background: "none", border: "none", color: "#83786c", fontSize: 18, cursor: "pointer", lineHeight: 1, transition: "color .1s" }}>×</button>
        </div>
        <WorldInfoPanel />
      </div>
    </Modal>
  );
}
