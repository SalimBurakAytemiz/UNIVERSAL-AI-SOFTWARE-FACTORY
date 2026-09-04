// Proof F + I (baseline section 306): "Idle agents do not continue
// consuming model calls" and "Event-driven triggers activate only relevant
// workflows." Combines the event bus with the cost engine to show that an
// agent which never receives its event never spends anything.
import { describe, expect, it } from "vitest";
import { EventBus, EventDrivenAgent } from "../../runtime/event-bus/event-bus.js";
import { CostEngine } from "../../runtime/cost/cost-engine.js";

describe("Proof: Event-driven agent activation", () => {
  it("an agent idle-waiting for 'pull_request.opened' spends nothing while unrelated events fire", async () => {
    const bus = new EventBus();
    const costEngine = new CostEngine();

    const qaAgent = new EventDrivenAgent("pull_request.opened", () => {
      costEngine.record({ taskId: "qa-run", provider: "mock", modelId: "m1", amountUsd: 0.05 });
    });
    qaAgent.attach(bus);

    // A flood of unrelated events must not activate the QA agent.
    await bus.emit({ type: "dependency.updated", payload: {} });
    await bus.emit({ type: "security.finding", payload: {} });
    await bus.emit({ type: "cost.anomaly", payload: {} });

    expect(qaAgent.invocations).toBe(0);
    expect(costEngine.total()).toBe(0);

    // Only its own event activates it, exactly once per occurrence.
    await bus.emit({ type: "pull_request.opened", payload: { number: 42 } });
    expect(qaAgent.invocations).toBe(1);
    expect(costEngine.total()).toBe(0.05);
  });
});
