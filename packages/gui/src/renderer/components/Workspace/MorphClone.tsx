import { forwardRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";

export interface MorphCloneProps {
  readonly overlay: RefObject<HTMLDivElement>;
  readonly variant: "user" | "herta";
  readonly text: string;
  /** Conversation language, for the 板砖→Brick display alias — the flying
   *  bubble must read exactly like the settled bubble it morphs into. */
  readonly lang: "zh" | "en";
  readonly widthPx?: number;
}

/** A floating bubble copy rendered into the workspace morph overlay,
 *  positioned/animated imperatively by the caller via the forwarded ref. */
export const MorphClone = forwardRef<HTMLDivElement, MorphCloneProps>(
  function MorphClone(props, ref): JSX.Element | null {
    if (props.overlay.current === null) return null;
    const bubbleClass =
      props.variant === "user" ? "user-bubble" : "herta-bubble";
    return createPortal(
      <div
        ref={ref}
        className={`message-bubble ${bubbleClass} morph-clone`}
        style={
          props.widthPx !== undefined
            ? { width: `${props.widthPx}px` }
            : undefined
        }
      >
        <div className="message-text">
          {renderBanzhuanText(props.text, "bubble", props.lang)}
        </div>
      </div>,
      props.overlay.current,
    );
  },
);
