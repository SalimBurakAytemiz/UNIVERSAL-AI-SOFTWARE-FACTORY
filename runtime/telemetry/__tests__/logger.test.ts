import { describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";

describe("Logger", () => {
  it("emits structured JSON with the recommended fields", () => {
    const lines: string[] = [];
    const logger = new Logger((line) => lines.push(line));
    logger.log({ eventType: "task.completed", taskId: "t1", duration: 42, result: "success" });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.eventType).toBe("task.completed");
    expect(parsed.taskId).toBe("t1");
    expect(parsed.duration).toBe(42);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("Public Proof E: redacts secret-shaped fields at any nesting depth", () => {
    const sink = vi.fn();
    const logger = new Logger(sink);
    logger.log({
      eventType: "integration.call",
      apiKey: "sk-live-should-never-appear", // secret-scan:allow (fake fixture value, not a real key)
      nested: { accessToken: "should-also-be-redacted", safeField: "ok" } // secret-scan:allow (fake fixture value)
    } as never);

    const line = sink.mock.calls[0]![0] as string;
    expect(line).not.toContain("sk-live-should-never-appear");
    expect(line).not.toContain("should-also-be-redacted");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("ok"); // non-sensitive nested field is preserved
  });
});
