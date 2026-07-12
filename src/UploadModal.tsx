import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, chromeButton, chromeButtonAccent } from "./designTokens";
import Modal from "./Modal";

interface UploadProgress {
  bytes_sent: number;
  total: number;
}

interface Props {
  sourcePath: string | null;
  onClose: () => void;
}


const btn: React.CSSProperties = chromeButton({ padding: "5px 13px", fontSize: 13 });

const radioLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  color: "#ebe9e7",
  fontSize: 13,
};

export default function UploadModal({ sourcePath, onClose }: Props) {
  const [server, setServer] = useState<"current" | "legacy">("current");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  async function choosePng() {
    const path = await open({
      filters: [{ name: "PNG Image", extensions: ["png"] }],
      multiple: false,
    });
    if (path && typeof path === "string") {
      setImagePath(path);
      setError(null);
    }
  }

  async function doUpload() {
    if (!sourcePath || !imagePath) return;
    setUploading(true);
    setUploadProgress(0);
    setResult(null);
    setError(null);

    unlistenRef.current?.();
    const unlisten = await listen<UploadProgress>("upload-progress", e => {
      const { bytes_sent, total } = e.payload;
      setUploadProgress(total > 0 ? Math.round((bytes_sent / total) * 100) : 0);
    });
    unlistenRef.current = unlisten;

    try {
      const response = await invoke<string>("upload_world", {
        worldPath: sourcePath,
        imagePath,
        server,
      });
      unlisten();
      unlistenRef.current = null;
      setUploadProgress(100);
      setResult(response || "Upload complete.");
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  const canUpload = !!sourcePath && !!imagePath && !uploading;
  const imageFilename = imagePath ? imagePath.split(/[\\/]/).pop() ?? imagePath : null;

  return (
    <Modal onClose={onClose} zIndex={1000} label="Upload World"
      backdropStyle={{ background: "rgba(0,0,0,0.75)" }}>
      <div
        style={glassPanel({
          padding: "18px 24px 20px", width: 400, maxWidth: "95vw",
          display: "flex", flexDirection: "column", gap: 14, color: "#ebe9e7",
        })}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Upload World</span>
          <button
            onClick={onClose}
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#61584f")}
            style={{ background: "none", border: "none", color: "#61584f", fontSize: 20, cursor: "pointer", lineHeight: 1, transition: "color .1s" }}
          >×</button>
        </div>

        {/* Server selection */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>Server</span>
          <div style={{ display: "flex", gap: 16 }}>
            <label style={radioLabel}>
              <input
                type="radio"
                name="server"
                value="current"
                checked={server === "current"}
                onChange={() => setServer("current")}
                style={{ accentColor: `rgb(${EDEN_TEAL})` }}
              />
              Current
            </label>
            <label style={radioLabel}>
              <input
                type="radio"
                name="server"
                value="legacy"
                checked={server === "legacy"}
                onChange={() => setServer("legacy")}
                style={{ accentColor: `rgb(${EDEN_TEAL})` }}
              />
              Legacy
            </label>
          </div>
          <span style={{ fontSize: 10, color: "#83786c", lineHeight: 1.5 }}>
            Uploads use plain HTTP — the world file, its name, and the preview travel unencrypted.
            Don't upload anything private.
          </span>
        </div>

        {/* World file */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>World File</span>
          {sourcePath ? (
            <span style={{ color: "#afa69d", fontSize: 13, wordBreak: "break-all" }}>
              {sourcePath.split(/[\\/]/).pop() ?? sourcePath}
            </span>
          ) : (
            <span style={{ color: "#f87171", fontSize: 13 }}>
              No world saved — use File → Save As… first.
            </span>
          )}
        </div>

        {/* Preview image */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#61584f", textTransform: "uppercase", letterSpacing: "0.06em" }}>Preview Image (required)</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={choosePng} style={btn}>
              Choose PNG…
            </button>
            {imageFilename && (
              <span style={{ color: "#4ade80", fontSize: 12 }}>✓ {imageFilename}</span>
            )}
          </div>
        </div>

        {/* Upload button + progress */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={doUpload}
            disabled={!canUpload}
            style={canUpload
              ? chromeButtonAccent(EDEN_TEAL, `rgb(${EDEN_TEAL})`, { color: EDEN_TEAL_READABLE, padding: "5px 13px", fontSize: 13 })
              : { ...btn, opacity: 0.4, cursor: "not-allowed" }}
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>

          {uploading && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, background: "#312c28", borderRadius: 4, height: 6, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  background: `linear-gradient(90deg, rgb(${EDEN_TEAL}) 0%, ${EDEN_TEAL_READABLE} 100%)`,
                  width: `${uploadProgress}%`,
                  transition: "width 0.3s",
                }} />
              </div>
              <span style={{ color: "#afa69d", fontSize: 12, minWidth: 36 }}>{uploadProgress}%</span>
            </div>
          )}

          {result && (
            <div style={{
              background: "rgba(34,197,94,0.1)",
              border: "1px solid #166534",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
              color: "#86efac",
            }}>
              {result}
            </div>
          )}

          {error && (
            <span style={{ color: "#f87171", fontSize: 13 }}>{error}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
