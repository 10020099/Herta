import { type ReactNode, useState } from "react";

export interface TooltipProps {
  readonly label: string;
  /** Optional muted second line (ADR 0033: the attach hint names the supported
   *  formats). A separate line rather than one long label because the pill is
   *  `white-space: nowrap` — appending detail to the label makes one very wide
   *  pill, while a subline keeps the primary action scannable. */
  readonly sub?: string;
  readonly placement?: "top" | "bottom";
  readonly align?: "start" | "center" | "end";
  readonly children: ReactNode;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const placement = props.placement ?? "bottom";
  const align = props.align ?? "center";
  // Dismiss on interaction: CSS :hover keeps the tooltip up after a click
  // because the cursor is still over the control. Like Codex/Claude, once the
  // user acts on the control the hint should vanish and stay gone until the
  // pointer leaves and returns (user 2026-06-13). pointerdown suppresses
  // immediately (before the click resolves); pointerleave re-arms it.
  const [suppressed, setSuppressed] = useState(false);
  return (
    <span
      className={`tooltip-wrap tooltip-${placement} tooltip-align-${align}${
        suppressed ? " is-suppressed" : ""
      }`}
      onPointerDown={() => setSuppressed(true)}
      onPointerLeave={() => setSuppressed(false)}
    >
      {props.children}
      <span className="tooltip" role="tooltip">
        {props.label}
        {props.sub !== undefined && (
          <span className="tooltip-sub">{props.sub}</span>
        )}
      </span>
    </span>
  );
}
