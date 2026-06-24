import { openUrl } from "@tauri-apps/plugin-opener";
import appIcon from "./assets/app-icon.png";

interface Props {
  version: string;
  onClose: () => void;
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); openUrl(href); }}
      style={{ color: "#60a5fa", textDecoration: "none" }}
      onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

export default function AboutModal({ version, onClose }: Props) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.7)", display: "flex",
        alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#13161f", border: "1px solid #1e2333",
        borderRadius: 16, padding: "40px 44px", width: 480,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
        boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
      }}>
        <img
          src={appIcon}
          alt="VuencEdit"
          style={{ width: 80, height: 80, borderRadius: 18, marginBottom: 16, imageRendering: "pixelated" }}
        />
        <div style={{ fontSize: 28, marginBottom: 6, letterSpacing: -0.5, lineHeight: 1 }}>
          <span style={{ fontWeight: 800, color: "#ffffff" }}>Vuenc</span>
          <span style={{ fontWeight: 400, color: "#cbd5e1" }}>Edit</span>
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
          style={{
            marginTop: 28, padding: "8px 32px",
            background: "rgba(255,255,255,0.06)", border: "1px solid #334155",
            borderRadius: 8, color: "#cbd5e1", fontSize: 14,
            cursor: "pointer",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
        >
          Close
        </button>
      </div>
    </div>
  );
}
