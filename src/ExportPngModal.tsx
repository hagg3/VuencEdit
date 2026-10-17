import { useState } from "react";
import { MODAL_TEXT } from "./designTokens";
import { Check } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";

export interface ExportPngOpts { selectionOnly: boolean; scale: number }

const SCALES = [1, 2, 4, 8];

/** Options step before the native save picker: selection-only crop and integer upscale (22.20). */
export default function ExportPngModal({
  selectionSize, worldSize, onExport, onClose,
}: {
  /** Committed selection's X/Y extent in blocks, or null when there is none. */
  selectionSize: { w: number; h: number } | null;
  worldSize: { w: number; h: number };
  onExport: (opts: ExportPngOpts) => void;
  onClose: () => void;
}) {
  const [selectionOnly, setSelectionOnly] = useState(selectionSize !== null);
  const [scale, setScale] = useState(1);
  const base = selectionOnly && selectionSize ? selectionSize : worldSize;
  const ow = base.w * scale, oh = base.h * scale;
  const tooBig = ow * oh > 256 * 1024 * 1024;
  return (
    <Dialog
      size="sm" icon="export" title="Export PNG" onClose={onClose}
      footer={
        <>
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <DialogButton variant="primary" disabled={tooBig} onClick={() => onExport({ selectionOnly: selectionOnly && selectionSize !== null, scale })}>
            Export…
          </DialogButton>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, color: MODAL_TEXT.secondary }}>
        <Check
          checked={selectionOnly && selectionSize !== null} disabled={selectionSize === null}
          onChange={setSelectionOnly}
          label={selectionSize ? `Selection only (${selectionSize.w}×${selectionSize.h} blocks)` : "Selection only (no selection)"}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ marginRight: 6 }}>Scale</span>
          {SCALES.map(k => (
            <DialogButton key={k} variant={k === scale ? "primary" : "neutral"} onClick={() => setScale(k)}>{k}×</DialogButton>
          ))}
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: tooBig ? MODAL_TEXT.secondary : undefined }}>
          {ow} × {oh} px{tooBig ? " — too large, lower the scale" : ""}
        </div>
      </div>
    </Dialog>
  );
}
