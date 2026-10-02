import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { MODAL_TEXT } from "./designTokens";
import { ACCENTS, DANGER_HEX, RAMP, armedRecipe, mix, rgba } from "./theme/theme";
import { Segmented } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";

// Lightened tints for text on the warm modal surface (mechanical hex-literal migration, Stage
// 14.15) — plain accent/danger hex fails AA there; these clear it with margin.
const RED_LIGHT = mix(RAMP.white, DANGER_HEX, 0.5);
const GREEN_TEXT = armedRecipe(ACCENTS.clipboard).text;
const TEAL_LIGHT = mix(RAMP.white, ACCENTS.primary, 0.5);

interface UploadProgress {
  bytes_sent: number;
  total: number;
}

interface Props {
  sourcePath: string | null;
  onClose: () => void;
}

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
    // Blocked mid-upload — dismissing wouldn't cancel the request, it would just hide it.
    <Dialog
      size="sm" icon="upload" title="Upload World" onClose={onClose} busy={uploading}
      footer={
        <DialogButton variant="primary" onClick={doUpload} disabled={!canUpload}>
          {uploading ? "Uploading…" : "Upload"}
        </DialogButton>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Server selection */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: MODAL_TEXT.secondary, textTransform: "uppercase", letterSpacing: "0.06em" }}>Server</span>
          <Segmented<"current" | "legacy">
            ariaLabel="Server" value={server} onChange={setServer}
            options={[{ id: "current", label: "Current" }, { id: "legacy", label: "Legacy" }]}
          />
          <span style={{ fontSize: 10, color: MODAL_TEXT.label, lineHeight: 1.5 }}>
            Uploads use plain HTTP and aren't encrypted. Don't upload anything private.
          </span>
        </div>

        {/* World file */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: MODAL_TEXT.secondary, textTransform: "uppercase", letterSpacing: "0.06em" }}>World File</span>
          {sourcePath ? (
            <span style={{ color: MODAL_TEXT.secondary, fontSize: 13, wordBreak: "break-all" }}>
              {sourcePath.split(/[\\/]/).pop() ?? sourcePath}
            </span>
          ) : (
            <span style={{ color: RED_LIGHT, fontSize: 13 }}>
              Save the world first (Save As…).
            </span>
          )}
        </div>

        {/* Preview image */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: MODAL_TEXT.secondary, textTransform: "uppercase", letterSpacing: "0.06em" }}>Preview Image (required)</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DialogButton onClick={choosePng}>Choose PNG…</DialogButton>
            {imageFilename && (
              <span style={{ color: GREEN_TEXT, fontSize: 12 }}>✓ {imageFilename}</span>
            )}
          </div>
        </div>

        {/* Progress + result */}
        {uploading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, background: RAMP.mbtn1, borderRadius: 4, height: 6, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                background: `linear-gradient(90deg, ${ACCENTS.primary} 0%, ${TEAL_LIGHT} 100%)`,
                width: `${uploadProgress}%`,
                transition: "width 0.3s",
              }} />
            </div>
            <span style={{ color: MODAL_TEXT.secondary, fontSize: 12, minWidth: 36 }}>{uploadProgress}%</span>
          </div>
        )}

        {result && (
          <div style={{
            background: rgba(ACCENTS.clipboard, 0.1),
            border: `1px solid ${rgba(ACCENTS.clipboard, 0.4)}`,
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 13,
            color: GREEN_TEXT,
          }}>
            {result}
          </div>
        )}

        {error && (
          <span style={{ color: RED_LIGHT, fontSize: 13 }}>{error}</span>
        )}
      </div>
    </Dialog>
  );
}
