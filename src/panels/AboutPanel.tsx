/**
 * The About content, extracted from `AboutModal` so the application menu's About pane and the
 * modal render the same thing. The modal survives because the splash screen has no ribbon.
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import appIcon from "../assets/app-icon.png";
import { EDEN_TEAL_READABLE } from "../designTokens";

/** Plain MAJOR.MINOR.PATCH comparison — mirrors `isNewerVersion` in App.tsx (the startup check),
 *  kept as its own small copy here rather than exported/shared since this is the only other
 *  caller and the two are unlikely to drift independently of each other. */
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map(n => parseInt(n, 10) || 0);
  const b = current.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

type UpdateCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; latestVersion: string; releaseUrl: string }
  | { kind: "error" };

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
  const [checkState, setCheckState] = useState<UpdateCheckState>({ kind: "idle" });

  async function checkForUpdates() {
    setCheckState({ kind: "checking" });
    try {
      const info = await invoke<{ latestVersion: string; releaseUrl: string }>("check_for_update");
      setCheckState(isNewerVersion(info.latestVersion, version)
        ? { kind: "available", latestVersion: info.latestVersion, releaseUrl: info.releaseUrl }
        : { kind: "upToDate" });
    } catch {
      setCheckState({ kind: "error" });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: compact ? "flex-start" : "center" }}>
      {/* `alignItems: flex-start`, not `center` — the update-check status line appearing below the
          button grows this row's right column taller, and a centered row would re-centre (i.e.
          shift down) the icon every time that happens. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: compact ? 14 : 18 }}>
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
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, alignItems: compact ? "flex-start" : "center" }}>
            <button
              onClick={checkForUpdates}
              disabled={checkState.kind === "checking"}
              style={{
                background: "none", border: "1px solid #3d3630", borderRadius: 5,
                color: EDEN_TEAL_READABLE, fontSize: 11, padding: "3px 9px",
                cursor: checkState.kind === "checking" ? "default" : "pointer",
                opacity: checkState.kind === "checking" ? 0.6 : 1,
              }}
            >
              {checkState.kind === "checking" ? "Checking…" : "Check for updates"}
            </button>
            {checkState.kind === "upToDate" && (
              <span style={{ fontSize: 11, color: "#83786c" }}>You're up to date.</span>
            )}
            {checkState.kind === "error" && (
              <span style={{ fontSize: 11, color: "#f87171" }}>Couldn't check for updates.</span>
            )}
            {checkState.kind === "available" && (
              <span style={{ fontSize: 11, color: "#83786c" }}>
                v{checkState.latestVersion} available — <Link href={checkState.releaseUrl}>download</Link>
              </span>
            )}
          </div>
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
