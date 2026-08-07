export interface ToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** Accessible name for the switch (the row title isn't programmatically tied). */
  readonly ariaLabel: string;
}

/**
 * iOS-style switch. A `<button role="switch">` so Space/Enter activate it
 * natively; the knob slides and the track tints via `aria-checked` in CSS.
 * Reusable across Settings sections.
 */
export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="settings-toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" aria-hidden="true" />
    </button>
  );
}
