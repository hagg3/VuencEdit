/**
 * Generic right-click context menu (Stage 14.14) — replaces the hand-rolled hex-coloured menu that
 * used to live inline in App.tsx's map context-menu block. Built entirely on the ribbon's `Popover`
 * primitive (`role="menu"`) and `MenuItem` row, so it inherits Popover's keyboard model for free:
 * focus lands on the first enabled item on open, Up/Down/Home/End rove, Enter/Space activate
 * (native `<button>` behaviour — `MenuItem` renders a real button), Escape and outside-click close,
 * Tab closes and lets focus continue past the opener. No second keyboard-nav implementation.
 *
 * Positioning: `Popover` anchors to a real DOM element's `getBoundingClientRect()`, so the menu's
 * anchor here is an invisible zero-size `position:fixed` div planted at the click point — the
 * click has no natural anchor element, but a 0×0 rect at (x, y) makes Popover's own
 * viewport-clamping math (`Math.max(4, Math.min(left, innerWidth - w - 4))` etc.) apply exactly as
 * it does for every other Popover, so the bespoke measure-after-mount clamp effect App.tsx used to
 * run for this menu is no longer needed.
 *
 * `onContextMenu`/`onMouseDown` guards: `Popover`'s own outside-click listener already ignores
 * mousedown inside the panel (`panelRef.current?.contains(e.target)`), so no `stopPropagation` is
 * needed there. The `preventDefault` on a second right-click landing on the menu itself is kept —
 * placed on a wrapper `<div>` around `<Popover>`, which works because React portals bubble
 * synthetic events through the *React* tree, not the DOM tree, so this wrapper still sees events
 * from inside the portaled panel.
 *
 * `dismissDelayMs={80}`: the one thing kept from the old hand-rolled menu rather than replaced —
 * see `Popover`'s own doc comment on that prop. This is the *only* outside-click mechanism now;
 * the old menu's separate 80ms-delayed `document.addEventListener("mousedown", …)` in App.tsx is
 * gone, not duplicated.
 */
import { Fragment, useRef } from "react";
import { Popover, MenuItem, MenuSeparator } from "../ribbon/primitives";
import type { IconName } from "../ribbon/icons";

export interface ContextMenuItem {
  /** Stable key. */
  id: string;
  label: string;
  icon?: IconName;
  onClick: () => void;
  /** Shortcut hint text, e.g. pulled from `COMMAND_META[id].keys` at the call site — this
   *  component doesn't reach into the registry itself, so an item without a real binding simply
   *  omits this rather than inventing one. */
  shortcut?: string;
  /** Radio-style "this is the current choice" highlight — the pushed-in `currentRow()` look,
   *  same as every other "current item" in the app (menu rows, sidebar tabs, Select options). */
  active?: boolean;
  disabled?: boolean;
  /** Draws a separator immediately above this item. */
  separatorBefore?: boolean;
}

export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div onContextMenu={e => e.preventDefault()}>
      {/* Zero-size anchor at the click point — see file doc comment. */}
      <div ref={anchorRef} style={{ position: "fixed", top: y, left: x, width: 0, height: 0 }} />
      <Popover anchorRef={anchorRef} onClose={onClose} role="menu" ariaLabel="Context menu"
        dismissDelayMs={80} style={{ minWidth: 210, padding: "4px 0" }}>
        {items.map(it => (
          <Fragment key={it.id}>
            {it.separatorBefore && <MenuSeparator />}
            <MenuItem
              label={it.label}
              icon={it.icon}
              active={it.active}
              disabled={it.disabled}
              shortcut={it.shortcut}
              onClick={() => { onClose(); it.onClick(); }}
            />
          </Fragment>
        ))}
      </Popover>
    </div>
  );
}
