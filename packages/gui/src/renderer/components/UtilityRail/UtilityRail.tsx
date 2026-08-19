import { DeviceCard } from "./DeviceCard.js";
import { PlanCard } from "./PlanCard.js";
import { TraceCard } from "./TraceCard.js";

export function UtilityRail(): JSX.Element {
  return (
    <aside className="utility-rail" data-testid="utility-rail">
      <DeviceCard />
      {/* 板砖's plan, under 板砖's device — present only while a dispatch is
          working through a 任务清单, and for a beat after it settles. */}
      <PlanCard />
      {/* The fallback for a dispatch with NO 任务清单 (every 极简 run):
          the record's own op rows, pinned. At most one of the two mounts —
          useTraceCard stands down the moment a todo projection exists. */}
      <TraceCard />
    </aside>
  );
}
