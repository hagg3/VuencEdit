import { openUrl } from "@tauri-apps/plugin-opener";
import appIcon from "./assets/app-icon.png";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, chromeButton } from "./designTokens";
import Modal from "./Modal";

interface Props {
  version: string;
  onClose: () => void;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); openUrl(href); }}
      style={{ color: EDEN_TEAL_READABLE, textDecoration: "none" }}
      onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

export default function AboutModal({ version, onClose }: Props) {
  return (
    <Modal onClose={onClose} zIndex={9999} label="About VuencEdit">
      <div style={glassPanel({
        padding: "40px 44px", width: 480, borderRadius: 16,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
      })}>
        <img
          src={appIcon}
          alt="VuencEdit"
          style={{
            width: 80, height: 80, borderRadius: 18, marginBottom: 16, imageRendering: "pixelated",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12), 0 6px 16px rgba(0,0,0,.5)",
          }}
        />
        <div style={{ fontSize: 28, marginBottom: 6, letterSpacing: -0.5, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, color: "#ffffff", textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Vuenc</span>
          <span style={{ fontWeight: 400, color: EDEN_TEAL_READABLE, textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Edit</span>
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 28 }}>v{version}</div>

        <div style={{
          fontSize: 13, color: "#94a3b8", lineHeight: 1.7, textAlign: "center",
          borderTop: "1px solid #1e2333", paddingTop: 20, width: "100%",
        }}>
          <p style={{ margin: "0 0 10px" }}>
            Based on{" "}
            <Link href="https://github.com/jldeiro/EdenWorldManipulator2.0">Eden World Manipulator</Link>
            {" "}which is itself based on{" "}
            <Link href="https://github.com/bLUUBfACE/EdenWorldManipulator">Vuenctools</Link>.
          </p>
          <p style={{ margin: "0 0 10px" }}>
            Original file format documentation by{" "}
            <Link href="https://mrob.com/pub/vidgames/eden-file-format.html">Robert Munafo</Link>.
          </p>
          <p style={{ margin: "0 0 10px" }}>
            Eden World Builder was created by Ari Ronen and made open source in 2018.
          </p>
          <p style={{ margin: 0 }}>
            For support, visit the{" "}
            <Link href="https://discord.com/invite/rjYXwBC">Discord server</Link>
            {" "}for the game and community.
          </p>
        </div>

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
