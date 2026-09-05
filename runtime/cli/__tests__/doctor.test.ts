import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorCheck } from "../commands/doctor.js";

describe("factory doctor", () => {
  it("reports READY for a tool that resolves, with its version as detail", () => {
    const fakeCheck: DoctorCheck = {
      name: "FakeTool",
      blocking: true,
      check: () => ({ name: "FakeTool", status: "READY", detail: "1.2.3" })
    };
    const [result] = runDoctor([fakeCheck]);
    expect(result!.status).toBe("READY");
    expect(result!.detail).toBe("1.2.3");
  });

  it("reports BLOCKING only for checks explicitly marked blocking when missing", () => {
    const missingBlocking: DoctorCheck = {
      name: "CriticalTool",
      blocking: true,
      check: () => ({ name: "CriticalTool", status: "BLOCKING", detail: "not found" })
    };
    const missingOptional: DoctorCheck = {
      name: "OptionalTool",
      blocking: false,
      check: () => ({ name: "OptionalTool", status: "OPTIONAL", detail: "not found" })
    };
    const results = runDoctor([missingBlocking, missingOptional]);
    expect(results[0]!.status).toBe("BLOCKING");
    expect(results[1]!.status).toBe("OPTIONAL");
  });

  it("real environment check: Node.js and npm are actually READY in this environment", () => {
    const results = runDoctor();
    const node = results.find((r) => r.name === "Node.js");
    const npm = results.find((r) => r.name === "npm");
    expect(node!.status).toBe("READY");
    expect(npm!.status).toBe("READY");
  });
});
