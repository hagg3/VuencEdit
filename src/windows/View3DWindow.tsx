/**
 * The 3D view window (UI redesign r3, Stage 14.4). Shows whichever viewport is *not* the main pane:
 * FlyView3D normally, the map when swapped (then titled "Map", with the 3D camera's view wedge drawn
 * on it). Its body is an `OutPortal` for the host node App hands it — the viewport itself is
 * rendered once, elsewhere, and only its DOM node moves in here (see `Reparentable.tsx`).
 *
 * Collapsing or closing it renders no body, which detaches the host; App derives `pane3dLive` from
 * the same store state, so FlyView3D is suspended exactly when its canvas has nowhere to be.
 */
import FloatingWindow, { WinButton } from "./FloatingWindow";
import { OutPortal } from "./Reparentable";
import { enlargeWin, useWindowLayout } from "./useWindowLayout";
import { RAMP } from "../theme/theme";

export default function View3DWindow({ swapped, node, onSwap, onMoved }: {
  swapped: boolean;
  /** The host node to show in the body, or null when nothing should be (collapsed/closed). */
  node: HTMLElement | null;
  onSwap: () => void;
  onMoved: () => void;
}) {
  const enlarged = !!useWindowLayout().wins.view3d.restore;
  return (
    <FloatingWindow
      id="view3d"
      title={swapped ? "Map" : "3D view"}
      icon={swapped ? "topdown" : "pane3d"}
      meta={swapped ? "3D camera's view shown" : undefined}
      onMoved={onMoved}
      bodyStyle={{ background: RAMP.mapBg }}
      buttons={<>
        <WinButton icon="swap" label="Swap map ⇄ 3D (Tab)" onClick={onSwap} />
        <WinButton icon={enlarged ? "restore" : "enlarge"} label={enlarged ? "Restore size" : "Enlarge"}
          active={enlarged} onClick={() => { enlargeWin("view3d"); onMoved(); }} />
      </>}
    >
      {node && <OutPortal node={node} />}
    </FloatingWindow>
  );
}
