import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runtime/**/*.test.ts", "proofs/**/*.test.ts", "tests/**/*.test.mjs"],
    environment: "node",
    passWithNoTests: false
  }
});
