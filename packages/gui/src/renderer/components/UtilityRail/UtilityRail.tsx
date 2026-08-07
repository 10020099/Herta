import { DeviceCard } from "./DeviceCard.js";
import { PlanCard } from "./PlanCard.js";

export function UtilityRail(): JSX.Element {
  return (
    <aside className="utility-rail" data-testid="utility-rail">
      <DeviceCard />
      {/* 板砖's plan, under 板砖's device — present only while a dispatch is
          working through a 任务清单, and for a beat after it settles. */}
      <PlanCard />
    </aside>
  );
}
