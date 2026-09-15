import { describe, expect, it } from "vitest";
import { EventBus, EventDrivenAgent } from "../event-bus.js";

describe("EventBus / EventDrivenAgent", () => {
  it("Proof I: only the handler registered for the emitted event type is invoked", async () => {
    const bus = new EventBus();
    let gitPushHandled = 0;
    let prOpenedHandled = 0;

    bus.on("git.push", () => {
      gitPushHandled++;
    });
    bus.on("pull_request.opened", () => {
      prOpenedHandled++;
    });

    await bus.emit({ type: "git.push", payload: {} });

    expect(gitPushHandled).toBe(1);
    expect(prOpenedHandled).toBe(0); // the irrelevant workflow was never activated
  });

  it("Proof F: an idle agent has zero invocations until its event actually fires", async () => {
    const bus = new EventBus();
    const agent = new EventDrivenAgent("security.finding", () => {});
    agent.attach(bus);

    expect(agent.invocations).toBe(0); // never polled, never ran

    await bus.emit({ type: "unrelated.event", payload: {} });
    expect(agent.invocations).toBe(0); // still idle — not its event

    await bus.emit({ type: "security.finding", payload: {} });
    expect(agent.invocations).toBe(1); // activated exactly once, for its own event
  });
});
