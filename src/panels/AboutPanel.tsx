/**
 * The About content, extracted from `AboutModal` so the application menu's About pane and the
 * modal render the same thing. The modal survives because the splash screen has no ribbon.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import appIcon from "../assets/app-icon.png";
import { EDEN_TEAL_READABLE } from "../designTokens";

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href="#"
      onClick={e => { e.preventDefault(); openUrl(href); }}
      style={{ color: EDEN_TEAL_READABLE, textDecoration: "none" }}
      onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

export default function AboutPanel({ version, compact }: { version: string; compact?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: compact ? "flex-start" : "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: compact ? 14 : 18 }}>
        <img
          src={appIcon}
          alt="VuencEdit"
          style={{
            width: compact ? 52 : 80, height: compact ? 52 : 80, borderRadius: compact ? 12 : 18,
            imageRendering: "pixelated",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12), 0 6px 16px rgba(0,0,0,.5)",
          }}
        />
        <div>
          <div style={{ fontSize: compact ? 24 : 28, letterSpacing: -0.5, lineHeight: 1.1 }}>
            <span style={{ fontWeight: 800, color: "#ffffff", textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Vuenc</span>
            <span style={{ fontWeight: 400, color: EDEN_TEAL_READABLE, textShadow: "0 -1px 0 rgba(0,0,0,.5)" }}>Edit</span>
          </div>
          <div style={{ fontSize: 12, color: "#83786c", marginTop: 3 }}>v{version}</div>
        </div>
      </div>

      <div style={{
        fontSize: 13, color: "#afa69d", lineHeight: 1.65,
        textAlign: compact ? "left" : "center",
        borderTop: "1px solid #2d2824", paddingTop: 16, width: "100%",
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
    </div>
  );
}
