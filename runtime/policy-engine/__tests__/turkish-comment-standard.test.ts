// P1 fix (P0 final closure remediation, finding 1, "authoritative P0
// registry is not closure-ready"): UASF-REQ-0039 (Turkish source code
// explanation standard) claimed, in its `implementation_refs`, that three
// specific files carry the mandatory Turkish "why" comments — but nothing
// ever re-checked that claim; it rested on the same one-time-prose-note
// footing findings 1/1's UASF-REQ-0001/0003 fixes already closed for other
// requirements. This test does NOT claim repo-wide completion (the
// requirement's own notes honestly disclose that as ongoing) — it verifies
// only the narrow, concrete claim the registry's `implementation_refs`
// field actually makes: that these exact three files genuinely contain
// Turkish-language comment text, detected via Turkish-specific letters
// (ç/ğ/ı/ö/ş/ü) appearing inside a `//` or `/* */` comment, not merely
// somewhere in a string literal.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

const TURKISH_LETTER_PATTERN = /[çğıöşüÇĞİÖŞÜ]/;

function commentLinesOf(source: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (inBlockComment) {
      lines.push(line);
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("//")) {
      lines.push(line);
    } else if (line.startsWith("/*")) {
      lines.push(line);
      if (!line.includes("*/")) inBlockComment = true;
    }
  }
  return lines;
}

describe("UASF-REQ-0039: the files this requirement's own registry entry claims as its implementation genuinely carry Turkish comments", () => {
  const claimedFiles = [
    "runtime/policy-engine/policy-engine.ts",
    "runtime/models/router.ts",
    "runtime/budget/budget.ts"
  ];

  it.each(claimedFiles)("%s contains at least one comment line with genuine Turkish-language text", (relativePath) => {
    const source = readFileSync(join(repoRoot, relativePath), "utf8");
    const turkishCommentLines = commentLinesOf(source).filter((line) => TURKISH_LETTER_PATTERN.test(line));
    expect(turkishCommentLines.length).toBeGreaterThan(0);
  });

  it("no regression: a file with zero Turkish-letter comments would be correctly detected as non-compliant by this same check", () => {
    const plainSource = "// this is a plain English comment with no diacritics\nexport const x = 1;\n";
    const turkishCommentLines = commentLinesOf(plainSource).filter((line) => TURKISH_LETTER_PATTERN.test(line));
    expect(turkishCommentLines).toHaveLength(0);
  });
});
