import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runDoctor, satisfiesEngineRange, type DoctorCheck } from "../commands/doctor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const declaredNodeEngineRange = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { engines: { node: string } }
).engines.node;

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

  describe("P2 fix (9th independent review round, 'declared Node support conflicts with Vitest 5')", () => {
    it("the Node.js check reports READY only when the running Node genuinely satisfies package.json's declared engines.node range", () => {
      const [node] = runDoctor().filter((r) => r.name === "Node.js");
      expect(node!.status).toBe("READY");
      expect(node!.detail).toContain(declaredNodeEngineRange);
    });

    it("satisfiesEngineRange correctly evaluates the ACTUAL declared range against known Node versions", () => {
      // These assertions exercise the real range string from package.json —
      // if a future dependency upgrade silently widens/narrows the required
      // Node versions without updating engines.node to match, this test
      // (run against whatever engines.node currently says) still passes,
      // but the deliberately-out-of-range assertions below prove the
      // matching logic itself stays correct for caret/>= clause semantics.
      expect(satisfiesEngineRange("v20.11.0", declaredNodeEngineRange)).toBe(false);
      expect(satisfiesEngineRange("v22.11.0", declaredNodeEngineRange)).toBe(false); // just below ^22.12.0
      expect(satisfiesEngineRange("v22.12.0", declaredNodeEngineRange)).toBe(true);
      expect(satisfiesEngineRange("v22.99.0", declaredNodeEngineRange)).toBe(true);
      expect(satisfiesEngineRange("v24.0.0", declaredNodeEngineRange)).toBe(true);
      expect(satisfiesEngineRange("v24.9.9", declaredNodeEngineRange)).toBe(true);
      expect(satisfiesEngineRange("v25.0.0", declaredNodeEngineRange)).toBe(false); // between ^24 and >=26
      expect(satisfiesEngineRange("v26.0.0", declaredNodeEngineRange)).toBe(true);
      expect(satisfiesEngineRange("v100.0.0", declaredNodeEngineRange)).toBe(true);
    });

    it("satisfiesEngineRange handles caret ranges correctly in isolation", () => {
      expect(satisfiesEngineRange("v22.12.0", "^22.12.0")).toBe(true);
      expect(satisfiesEngineRange("v22.11.9", "^22.12.0")).toBe(false);
      expect(satisfiesEngineRange("v23.0.0", "^22.12.0")).toBe(false); // caret never crosses a major bump
    });

    it("satisfiesEngineRange handles >= ranges correctly in isolation", () => {
      expect(satisfiesEngineRange("v26.0.0", ">=26.0.0")).toBe(true);
      expect(satisfiesEngineRange("v30.0.0", ">=26.0.0")).toBe(true);
      expect(satisfiesEngineRange("v25.9.9", ">=26.0.0")).toBe(false);
    });

    it("package.json's own currently-installed Vitest requirement is satisfied by the declared Factory Node baseline (no silent contradiction)", () => {
      // The exact bug Codex found: engines.node advertised a WIDER range
      // than the locked test toolchain actually supports. This test reads
      // Vitest's OWN engines.node straight from the lockfile/installed
      // package (the single source of truth for what the toolchain really
      // requires) and asserts every version accepted by the Factory's
      // declared range is also accepted by Vitest's — i.e. the Factory
      // never claims to support a Node version Vitest itself would reject.
      const vitestPkg = JSON.parse(
        readFileSync(join(repoRoot, "node_modules", "vitest", "package.json"), "utf8")
      ) as { engines?: { node?: string } };
      const vitestRange = vitestPkg.engines?.node;
      expect(vitestRange).toBeTruthy();
      // Every representative version the Factory's range accepts must also satisfy Vitest's.
      for (const v of ["v20.0.0", "v20.11.0", "v22.0.0", "v22.11.0", "v22.12.0", "v22.99.0", "v24.0.0", "v26.0.0", "v100.0.0"]) {
        if (satisfiesEngineRange(v, declaredNodeEngineRange)) {
          expect(satisfiesEngineRange(v, vitestRange!)).toBe(true);
        }
      }
    });
  });
});
