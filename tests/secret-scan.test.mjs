import { describe, expect, it } from "vitest";
import { findSecretsInText, isPlaceholderValue, findNonPlaceholderEnvLines } from "../scripts/secret-scan.mjs";

describe("secret-scan: findSecretsInText", () => {
  it("flags a hardcoded AWS access key id", () => {
    const findings = findSecretsInText("const key = 'AKIAABCDEFGHIJKLMNOP';", "example.ts");
    expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
  });

  it("flags a PEM private key block", () => {
    const findings = findSecretsInText("-----BEGIN RSA PRIVATE KEY-----", "id_rsa");
    expect(findings.some((f) => f.pattern === "Private key block")).toBe(true);
  });

  it("flags a generic apiKey assignment with a real-looking value", () => {
    const findings = findSecretsInText('const apiKey = "abcdef1234567890xyz";', "config.ts");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not flag an empty placeholder assignment", () => {
    const findings = findSecretsInText("API_KEY=", ".env.example");
    expect(findings).toHaveLength(0);
  });

  it("respects the secret-scan:allow escape hatch for deliberate test fixtures", () => {
    const findings = findSecretsInText(
      'apiKey: "sk-live-should-never-appear", // secret-scan:allow (fake fixture value)',
      "fixture.test.ts"
    );
    expect(findings).toHaveLength(0);
  });

  it("does not flag ordinary source code with no secret-shaped content", () => {
    const findings = findSecretsInText("export function add(a, b) { return a + b; }", "math.ts");
    expect(findings).toHaveLength(0);
  });
});

describe("secret-scan: .env.example placeholder checks", () => {
  it("accepts empty and angle-bracket placeholders", () => {
    expect(isPlaceholderValue("")).toBe(true);
    expect(isPlaceholderValue("<your-key-here>")).toBe(true);
    expect(isPlaceholderValue("your-anthropic-key")).toBe(true);
    expect(isPlaceholderValue("changeme")).toBe(true);
  });

  it("rejects a real-looking value", () => {
    expect(isPlaceholderValue("sk-ant-abc123def456ghi789")).toBe(false);
  });

  it("finds non-placeholder lines in .env.example-shaped content", () => {
    const findings = findNonPlaceholderEnvLines("ANTHROPIC_API_KEY=\nDATABASE_URL=<your-db-url>\nLEAKED=sk-ant-realvalue1234567890");
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toContain("LEAKED");
  });
});
