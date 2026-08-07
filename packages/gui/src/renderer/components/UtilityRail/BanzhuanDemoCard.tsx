import agentDevice from "../../assets/agent_device.png";
import agentDeviceNight from "../../assets/agent_device_night.png";
import agentShadow from "../../assets/agent_shadow.png";
import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";
import { DeviceGlow } from "./DeviceGlow.js";

export interface BanzhuanDemoCardProps {
  readonly state: BanzhuanDeviceState;
  /** Hovering the card pauses the demo cycle. The parent owns the timer. */
  readonly onHoverChange?: (hovering: boolean) => void;
}

/**
 * A read-only instance of the 板砖 device card for the Settings lifecycle demo.
 * It SHARES the live card's visuals (`.device-card` + the `DeviceGlow` shader
 * layer) so it looks exactly like the one in the rail, but is NON-INTERACTIVE:
 * no drag-to-lift, no `CardMenu`, no easter egg. Its `state` is driven by
 * `useDemoDeviceCycle` in the parent pane. The card is `aria-hidden` — the
 * synced caption + legend carry the meaning for AT.
 */
export function BanzhuanDemoCard({
  state,
  onHoverChange,
}: BanzhuanDemoCardProps): JSX.Element {
  return (
    <section
      className="device-card settings-bz-card"
      data-state={state}
      aria-hidden="true"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <div className="agent-preview">
        <img className="agent-layer agent-shadow" src={agentShadow} alt="" />
        <div className="agent-lift-group">
          <img
            className="agent-layer agent-device-img agent-device-img--day"
            src={agentDevice}
            alt=""
          />
          <img
            className="agent-layer agent-device-img agent-device-img--night"
            src={agentDeviceNight}
            alt=""
            aria-hidden="true"
          />
          <DeviceGlow state={state} />
        </div>
      </div>
    </section>
  );
}
