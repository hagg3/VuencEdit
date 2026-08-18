import { EDEN_TEAL, glassPanel, chromeButton } from "./designTokens";
import Modal from "./Modal";
import AboutPanel from "./panels/AboutPanel";

/**
 * Thin `Modal` wrapper around `AboutPanel`. The application menu shows the same panel in its
 * About pane; this modal survives because the splash screen has no ribbon to open that menu from.
 */
export default function AboutModal({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <Modal onClose={onClose} zIndex={9999} label="About VuencEdit">
      <div style={glassPanel({
        padding: "40px 44px", width: 480, borderRadius: 16,
        display: "flex", flexDirection: "column", alignItems: "center",
      })}>
        <AboutPanel version={version} />
        <button
          onClick={onClose}
          style={chromeButton({ marginTop: 28, padding: "8px 32px", fontSize: 14 })}
          onMouseEnter={e => (e.currentTarget.style.boxShadow = `inset 0 0 0 1px rgba(${EDEN_TEAL},.6), 0 .5px .5px rgba(255,255,255,.2)`)}
          onMouseLeave={e => (e.currentTarget.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)")}
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
