/**
 * Render a component **once** and move its DOM between places (UI redesign r3, Stage 14.4).
 *
 * `MapCanvas` and `FlyView3D` are each rendered into a *detached host node* (`<InPortal>`, via
 * `createPortal`) at a fixed position in App's React tree. Whichever layout wants a viewport renders
 * an `<OutPortal>`, which `appendChild`s the host node into itself. Swapping map ⇄ 3D, or moving 3D between the main area and its window therefore **moves a DOM node** —
 * React never unmounts either component, and the `<canvas>` and its WebGL context survive
 * (FlyView3D's suspend-don't-unmount rule; its true-unmount `forceContextLoss()` path never runs).
 *
 * ⚠️ React events follow the **React** tree, not the DOM: a pointerdown on the 3D canvas bubbles
 * (React-wise) to `<InPortal>`'s ancestors, never to the window it now sits in. Anything a window
 * frame must observe from its body (click-to-front) is a native capture-phase listener.
 *
 * Same semantics as `react-reverse-portal`, in ~40 lines instead of a dependency.
 */
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function createHostNode(name: string): HTMLDivElement {
  const el = document.createElement("div");
  el.dataset.viewportHost = name;
  // The host fills whatever `OutPortal` it is placed in.
  el.style.cssText = "position:absolute;inset:0;";
  return el;
}

export function InPortal({ node, children }: { node: HTMLElement; children: ReactNode }) {
  return createPortal(children, node);
}

/**
 * Where a host node is shown. Only removes the node on cleanup if it is still this container's
 * child — the next `OutPortal` may already have adopted it (its layout effect can run first when
 * one layout replaces another in the same commit).
 */
export function OutPortal({ node, style, className, dataTour }: {
  node: HTMLElement; style?: CSSProperties; className?: string; dataTour?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.appendChild(node);
    return () => { if (node.parentNode === box) box.removeChild(node); };
  }, [node]);
  return <div ref={ref} className={className} data-tour={dataTour} style={{ position: "relative", width: "100%", height: "100%", ...style }} />;
}
