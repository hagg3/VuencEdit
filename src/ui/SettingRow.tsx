/**
 * Settings-dialog layout primitives, shared with the New World modal (19.10): the two-column
 * `SettingRow` and the small-caps `SectionHeading`. They were private to `SettingsModal.tsx`.
 */
import type { CSSProperties, ReactNode } from "react";
import { MODAL_TEXT } from "../designTokens";
import { FONT, TEXT_LABEL } from "../ribbon/tokens";
import { v } from "../theme/cssVars";

export const rowDivider = `1px solid ${v("border-modalHairline")}`;

/** Two-column settings row (plan §3.3): label + one-line description on the left, one control
 *  right-aligned. Replaces the old "checkbox + stacked label" rows. */
export function SettingRow({
  label, badge, description, children, last, align = "center",
}: {
  label: string; badge?: ReactNode; description?: ReactNode; children: ReactNode;
  last?: boolean; align?: CSSProperties["alignItems"];
}) {
  return (
    <div style={{
      display: "flex", alignItems: align, justifyContent: "space-between", gap: 16,
      padding: "9px 0", borderBottom: last ? "none" : rowDivider,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: FONT.body, color: MODAL_TEXT.primary, display: "flex", alignItems: "center" }}>
          {label}{badge}
        </span>
        {description && (
          <span style={{ fontSize: FONT.label, color: MODAL_TEXT.secondary, lineHeight: 1.4 }}>
            {description}
          </span>
        )}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{children}</div>
    </div>
  );
}

/** Stacked settings row for controls too wide for `SettingRow`'s right-hand column (a 4-5 option
 *  `Segmented`, a slider): label + one-line description on top, the control underneath. Same
 *  `9px 0` density and hairline divider as `SettingRow`. `label` is optional for a bare slider. */
export function SettingBlock({
  label, badge, description, children, last,
}: {
  label?: string; badge?: ReactNode; description?: ReactNode; children: ReactNode; last?: boolean;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6, padding: "9px 0",
      borderBottom: last ? "none" : rowDivider,
    }}>
      {(label || description) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {label && (
            <span style={{ fontSize: FONT.body, color: MODAL_TEXT.primary, display: "flex", alignItems: "center" }}>
              {label}{badge}
            </span>
          )}
          {description && (
            <span style={{ fontSize: FONT.label, color: MODAL_TEXT.secondary, lineHeight: 1.4 }}>
              {description}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** Small-caps section heading (`FONT.label`/`TEXT_LABEL`), the plan's `md-sec`/`md-cap`. */
export function SectionHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div style={{
      fontSize: FONT.label, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
      color: TEXT_LABEL, margin: first ? "0 0 6px" : "16px 0 6px",
    }}>
      {children}
    </div>
  );
}
