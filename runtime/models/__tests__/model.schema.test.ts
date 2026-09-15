// P2 fix (23rd independent review round, "align model JSON schema with
// runtime model record contract"): Codex found that schemas/model.schema.json
// and the runtime ModelRecord contract (runtime/models/registry.ts)
// genuinely disagreed — the schema required a "costClass" field the
// runtime never had or used, and made "costPerCall" (the field routing
// and cost accounting ACTUALLY depend on) merely optional. This meant
// every real runtime ModelRecord failed schema validation, and a
// schema-valid EXTERNAL record could omit the pricing routing/accounting
// require. Fixed by making costPerCall required (matching what the
// runtime always populates and consumes) and costClass optional
// (matching that nothing in the runtime contract ever reads or writes
// it). These tests prove the reconciliation is genuine, not just a
// blanket loosening of both sides.

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import { createDefaultModelRegistry, ModelRegistry, type ModelRecord } from "../registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "..", "..", "schemas", "model.schema.json");

describe("schemas/model.schema.json <-> runtime ModelRecord contract alignment", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    validate = ajv.compile(schema);
  });

  it("every default registry record (createDefaultModelRegistry) passes schema validation", () => {
    const records = createDefaultModelRegistry().all();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const ok = validate(record);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("a schema-valid record (with costPerCall) can be accepted by ModelRegistry.register() without throwing", () => {
    const candidate = {
      provider: "mock",
      modelId: "schema-round-trip-model",
      tier: "STANDARD",
      costPerCall: 0.05,
      capabilities: ["summarization"],
      status: "ACTIVE"
    };
    expect(validate(candidate)).toBe(true);

    const registry = new ModelRegistry();
    expect(() => registry.register(candidate as ModelRecord)).not.toThrow();
    expect(registry.all().some((m) => m.modelId === "schema-round-trip-model")).toBe(true);
  });

  it("REGRESSION: a record missing the required pricing field (costPerCall) is REJECTED by the schema", () => {
    const missingPricing = {
      provider: "mock",
      modelId: "no-price-model",
      tier: "STANDARD",
      capabilities: ["summarization"],
      status: "ACTIVE"
      // costPerCall intentionally omitted
    };
    expect(validate(missingPricing)).toBe(false);
    expect(validate.errors?.some((e) => e.message?.includes("costPerCall"))).toBe(true);
  });

  it("a record carrying the OLD, no-longer-required 'costClass' field alongside costPerCall still validates (additive, not a regression for existing external tooling)", () => {
    const withCostClass = {
      provider: "mock",
      modelId: "cost-class-model",
      tier: "STANDARD",
      costClass: "LOW",
      costPerCall: 0.02,
      capabilities: ["summarization"],
      status: "ACTIVE"
    };
    expect(validate(withCostClass)).toBe(true);
  });

  it("a record with ONLY the old-style required set (costClass, no costPerCall) is now correctly rejected — proving the fix, not just a cosmetic description change", () => {
    const oldStyleOnly = {
      provider: "mock",
      modelId: "old-style-model",
      tier: "STANDARD",
      costClass: "LOW",
      capabilities: ["summarization"],
      status: "ACTIVE"
      // no costPerCall — this is exactly the shape the OLD schema considered complete
    };
    expect(validate(oldStyleOnly)).toBe(false);
  });

  it("runtime serialization round-trips correctly through the schema: a real ModelRecord, JSON-serialized and re-parsed, still validates and can be re-registered", () => {
    const original = createDefaultModelRegistry().all()[1]!; // mock-standard-coder
    const roundTripped = JSON.parse(JSON.stringify(original)) as ModelRecord;

    expect(validate(roundTripped)).toBe(true);

    const registry = new ModelRegistry();
    expect(() => registry.register(roundTripped)).not.toThrow();
    expect(registry.all().find((m) => m.modelId === original.modelId)?.costPerCall).toBe(original.costPerCall);
  });
});
