/**
 * Help's keyboard table, generated from the command registry (14.6) — it used to be a hand-kept
 * mirror of App's keydown handler, which is exactly the drift the registry exists to prevent.
 * Rows come from every command with `keys` (+ its `help` text/section) and from `GESTURES`.
 */
import type { ReactNode } from "react";
import { COMMAND_IDS, GESTURES, HELP_SECTIONS, meta, type HelpSection } from "./meta";
import { chordParts, type Chord } from "./keys";

interface Row { keys?: readonly Chord[]; gesture?: string; text: string }

/** Sections in display order, each with its rows (commands first, then gestures). Pure. */
export function shortcutRows(): { section: HelpSection; rows: Row[] }[] {
  const by = new Map<HelpSection, Row[]>(HELP_SECTIONS.map(s => [s, []]));
  for (const id of COMMAND_IDS) {
    const m = meta(id);
    if (!m.keys?.length) continue;
    const section: HelpSection = m.help?.section
      ?? ("tab" in m.path && m.path.tab === "sculpt" ? "Sculpt" : "General");
    by.get(section)!.push({ keys: m.keys, text: m.help?.text ?? m.label });
  }
  for (const g of GESTURES) by.get(g.section)!.push({ keys: g.keys, gesture: g.gesture, text: g.text });
  return HELP_SECTIONS.map(section => ({ section, rows: by.get(section)! })).filter(s => s.rows.length > 0);
}

export default function ShortcutTable({ Key, Section, RowEl }: {
  Key: (p: { children: ReactNode }) => ReactNode;
  Section: (p: { title: string }) => ReactNode;
  RowEl: (p: { keys: ReactNode; action: string }) => ReactNode;
}) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <tbody>
        {shortcutRows().map(({ section, rows }) => [
          <Section key={section} title={section} />,
          ...rows.map((r, i) => (
            <RowEl key={`${section}-${i}`} action={r.text}
              keys={r.gesture ?? (r.keys ?? []).map((c, j) => (
                <span key={j}>
                  {j > 0 && " / "}
                  {c.hold && "Hold "}
                  {chordParts(c).map((part, n) => <Key key={n}>{part}</Key>)}
                </span>
              ))} />
          )),
        ])}
      </tbody>
    </table>
  );
}
