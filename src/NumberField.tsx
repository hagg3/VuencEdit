import { useState } from "react";

interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  style?: React.CSSProperties;
  title?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

/**
 * A numeric `<input>` that tolerates transient, un-parseable states while you type.
 *
 * The plain controlled idiom this replaces — `value={n} onChange={e => set(Math.max(1, parseInt(e.target.value,10) || 1))}`
 * — clamps on every keystroke, so selecting the contents and pressing Delete instantly snaps the
 * field to `1` and you can never type a replacement value: the field is never allowed to be empty.
 * Same for a lone "-" while typing a negative.
 *
 * Here the typed text is held locally (`text`) and shown verbatim; the parent is only notified when
 * the text actually parses. On blur (or Enter) the local text is dropped and the field re-syncs to
 * the parent's canonical, clamped value.
 */
export default function NumberField({ value, onChange, min, max, style, title, disabled, ...rest }: Props) {
  // null = not being edited; show the parent's value.
  const [text, setText] = useState<string | null>(null);

  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));

  return (
    <input
      type="number"
      min={min}
      max={max}
      title={title}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      value={text ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = parseInt(raw, 10);
        // "", "-", "1e" etc. are legitimate mid-typing states — hold them, don't coerce.
        if (raw.trim() !== "" && Number.isFinite(n)) onChange(clamp(n));
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      style={style}
    />
  );
}
