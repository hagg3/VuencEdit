/**
 * `Dialog`'s side navigation (UI redesign r3, Stage 14.17, plan §3.3) — the "use horizontal space"
 * half of the modal redesign: a fixed left column of icon+label rows instead of a top tab strip
 * whose row grows/shrinks with the tab's content.
 *
 * `role="tablist"` / `aria-orientation="vertical"`, roving tabindex (only the selected row is a tab
 * stop), ↑/↓/Home/End move + select — the same keyboard model `ribbon/primitives.tsx`'s `Segmented`
 * already uses for its (horizontal) radiogroup, adapted to vertical + `role="tab"`.
 */
import { useRef, type ReactNode } from "react";
import { Icon, type IconName } from "../ribbon/icons";
import { FONT, ICON, RADIUS, currentRow } from "../ribbon/tokens";
import { MODAL_TEXT_ROLES } from "../theme/theme";
import { v } from "../theme/cssVars";
import { sfx } from "../sound/sfx";

const MODAL_TEXT = MODAL_TEXT_ROLES;

export const DIALOG_NAV_W = 184;

export interface DialogNavItem {
  id: string;
  icon: IconName;
  label: string;
  description?: string;
}

export function DialogNav({
  items, value, onChange, footer,
}: {
  items: DialogNavItem[];
  value: string;
  onChange: (id: string) => void;
  footer?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function move(from: number, key: string): boolean {
    const n = items.length;
    let to = -1;
    if (key === "ArrowDown") to = (from + 1) % n;
    else if (key === "ArrowUp") to = (from - 1 + n) % n;
    else if (key === "Home") to = 0;
    else if (key === "End") to = n - 1;
    if (to < 0) return false;
    if (items[to].id !== value) sfx.play("tab");
    onChange(items[to].id);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
    return true;
  }

  const checkedIndex = Math.max(0, items.findIndex(it => it.id === value));

  return (
    <div style={{
      width: DIALOG_NAV_W, flexShrink: 0, display: "flex", flexDirection: "column",
      background: v("surface-modalNav"),
      boxShadow: `inset -1px 0 0 ${v("border-modalHairline")}`,
      padding: "8px 6px", overflow: "hidden",
    }}>
      <div
        ref={listRef} role="tablist" aria-orientation="vertical"
        style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {items.map((it, idx) => {
          const selected = it.id === value;
          return (
            <button
              key={it.id} type="button" role="tab" aria-selected={selected}
              tabIndex={idx === checkedIndex ? 0 : -1}
              onKeyDown={e => { if (move(idx, e.key)) { e.preventDefault(); e.stopPropagation(); } }}
              onClick={() => { if (!selected) sfx.play("tab"); onChange(it.id); }}
              style={{
                display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left",
                border: "none", background: "none", cursor: "pointer", outline: "none",
                padding: "6px 8px", borderRadius: RADIUS.md, color: MODAL_TEXT.primary,
                ...(selected ? currentRow() : null),
              }}
            >
              <span style={{ display: "flex", flexShrink: 0, marginTop: 1 }}>
                <Icon name={it.icon} size={ICON.sm} tone={selected ? "inherit" : "default"} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{
                  fontSize: FONT.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {it.label}
                </span>
                {it.description && (
                  <span style={{
                    fontSize: FONT.label, color: MODAL_TEXT.secondary, lineHeight: 1.3,
                  }}>
                    {it.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {footer && <div style={{ marginTop: 6, flexShrink: 0 }}>{footer}</div>}
    </div>
  );
}
