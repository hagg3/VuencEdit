/**
 * A button + popover for the options bar's "Shape ▾" and "More ▾" (34.2, plan §4.3).
 *
 * Not `DropdownButton`: that one closes on *any* click inside it, which would dismiss the panel the
 * moment a slider drag ends. This panel stays open while its controls are used and closes on Esc or
 * an outside click (`Popover`'s own rules). The root carries `data-bar-popover` and the panel
 * `data-bar-panel`, so ⌘K's reveal can open it and find a control folded inside it.
 */
import { useRef, useState, type ReactNode } from "react";
import { Popover, SmallButton } from "./primitives";
import type { IconName } from "./icons";
import { Icon } from "./icons";
import { ICON, ROW_GAP, SPACE } from "./tokens";

export default function BarPopover({ kind, label, title, icon, accent, iconOnly, children }: {
  kind: "shape" | "more";
  label: string; title: string; icon?: IconName; accent?: string; iconOnly?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={ref} data-bar-popover={kind} style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      <SmallButton
        icon={icon} label={label} title={title} accent={accent} iconOnly={iconOnly}
        active={open} onClick={() => setOpen(v => !v)}
        badge={<Icon name="split" size={ICON.xs} tone="inherit" />}
      />
      {open && (
        <Popover anchorRef={ref} onClose={() => setOpen(false)} role="dialog" ariaLabel={title}>
          <div data-bar-panel style={{ display: "flex", gap: SPACE.lg * 2, padding: SPACE.lg, alignItems: "flex-start" }}>
            {children}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** One column inside a `BarPopover` panel. */
export function BarCol({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>{children}</div>;
}
