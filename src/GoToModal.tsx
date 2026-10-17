import { useState } from "react";
import { FONT, TEXT_DIM } from "./ribbon/tokens";
import { NumField } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";
import { SettingBlock } from "./ui/SettingRow";

interface Props {
  /** Map extent in world pixels (the status-bar X/Y space): valid X is 0 … width-1. */
  width: number;
  height: number;
  /** Where the map is looking now, to pre-fill the fields. */
  initial: { x: number; y: number };
  onGo: (x: number, y: number) => void;
  onClose: () => void;
}

/** View ▸ Go to X, Y — recentre the map on a coordinate, in the same units the status bar reads. */
export default function GoToModal({ width, height, initial, onGo, onClose }: Props) {
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v)));
  const [x, setX] = useState(clamp(initial.x, width - 1));
  const [y, setY] = useState(clamp(initial.y, height - 1));
  const go = () => { onGo(clamp(x, width - 1), clamp(y, height - 1)); onClose(); };
  return (
    <Dialog
      size="sm" icon="zoomSel" title="Go to X, Y" onClose={onClose}
      footer={<>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" onClick={go}>Go</DialogButton>
      </>}
    >
      <div onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); go(); } }}>
        <SettingBlock label="Coordinates" description={`The map's X / Y, as the status bar shows. 0–${width - 1} × 0–${height - 1}.`}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: FONT.label, color: TEXT_DIM }}>
            X <NumField min={0} max={width - 1} value={x} onChange={setX} ariaLabel="X coordinate" width={72} />
            Y <NumField min={0} max={height - 1} value={y} onChange={setY} ariaLabel="Y coordinate" width={72} />
          </div>
        </SettingBlock>
      </div>
    </Dialog>
  );
}
