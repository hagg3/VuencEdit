import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Rocker / ↑↓ increment. Default 1. */
  step?: number;
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
export default function NumberField({ value, onChange, min, max, step = 1, style, title, disabled, ...rest }: Props) {
  // null = not being edited; show the parent's value.
  const [text, setText] = useState<string | null>(null);

  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));

  // The rocker replaces the OS spin buttons (hidden by `.vx-numfield` in THEME_CSS). Press-and-hold
  // repeats; `latest` keeps the repeat timer stepping from what's shown, not a stale closure.
  const latest = useRef({ value, text, onChange, clamp, step });
  useEffect(() => { latest.current = { value, text, onChange, clamp, step }; });
  const [hold] = useState(() => {
    let delay = 0, tick = 0;
    const stop = () => { window.clearTimeout(delay); window.clearInterval(tick); };
    return {
      stop,
      start: (fn: () => void) => {
        stop();
        delay = window.setTimeout(() => { tick = window.setInterval(fn, 55); }, 380);
      },
    };
  });
  useEffect(() => hold.stop, [hold]);
  const bump = (dir: 1 | -1) => {
    const c = latest.current;
    const typed = c.text === null ? NaN : parseFloat(c.text);
    const base = Number.isFinite(typed) ? typed : c.value;
    const decimals = Math.max(0, ...[c.step, base].map((x) => (String(x).split(".")[1] ?? "").length));
    c.onChange(Number(c.clamp(base + dir * c.step).toFixed(decimals)));
    setText(null);
  };
  const press = (dir: 1 | -1) => (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault(); // keep focus/caret where it was
    bump(dir);
    hold.start(() => bump(dir));
  };
  const { width, flex, minWidth, margin, height, ...inputStyle } = style ?? {};

  const chev = (up: boolean) => (
    <svg width="7" height="4" viewBox="0 0 7 4" aria-hidden="true">
      <path d={up ? "M.7 3.3 3.5.7l2.8 2.6" : "M.7.7 3.5 3.3 6.3.7"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <span className="vx-numfield" data-disabled={disabled || undefined}
      style={{ position: "relative", display: "inline-flex", width, flex, minWidth, margin, height }}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        title={title}
        disabled={disabled}
        aria-label={rest["aria-label"]}
        value={text ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          // parseFloat (not parseInt): SliderRow's click-to-type value field (Stage 15.5) reuses
          // this for fractional-step sliders (e.g. 0.01) — parseInt silently truncated "0.35" to 0.
          const n = parseFloat(raw);
          // "", "-", "1e", "0." etc. are legitimate mid-typing states — hold them, don't coerce.
          if (raw.trim() !== "" && Number.isFinite(n)) onChange(clamp(n));
        }}
        onBlur={() => setText(null)}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        style={{ ...inputStyle, width: "100%", height: "100%", boxSizing: "border-box", paddingRight: 14 }}
      />
      <span className="vx-rocker" aria-hidden="true">
        <button type="button" tabIndex={-1} disabled={disabled} onPointerDown={press(1)} onPointerUp={hold.stop} onPointerLeave={hold.stop} onPointerCancel={hold.stop}>{chev(true)}</button>
        <button type="button" tabIndex={-1} disabled={disabled} onPointerDown={press(-1)} onPointerUp={hold.stop} onPointerLeave={hold.stop} onPointerCancel={hold.stop}>{chev(false)}</button>
      </span>
    </span>
  );
}
