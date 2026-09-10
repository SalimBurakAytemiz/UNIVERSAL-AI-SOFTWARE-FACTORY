// P1 fix (P0 final closure remediation, finding 1, "authoritative P0
// registry is not closure-ready"): UASF-REQ-0001 ("existing public
// repository audit") and UASF-REQ-0003 ("baseline specification
// preservation") both used to rest on ONE-TIME PROSE CLAIMS recorded in
// the requirement registry's own `notes` field ("Session audit: ...",
// "verbatim preservation") — true when written, but never a re-checkable
// artifact: no file, no test, no CI job ever confirmed either claim
// again. This is exactly the "unverifiable free-text evidence" class the
// 30th independent review round already fixed for `proof_refs`/
// `test_refs` (bkz. `requirements-traceability/traceability.ts`'s
// `isVerifiedEvidenceRef()` fix notu) — a `notes` paragraph is no
// different, and both requirements were correctly held below the
// UNIT_TESTED closure threshold for it.
//
// Both claims are actually about durable GIT HISTORY, not runtime
// behavior — so unlike most P0 requirements, their evidence is not a
// unit test of application code but a reproducible check against this
// repository's own commit graph and tags, which every clone/CI run can
// re-verify identically. That is what this file does: it re-derives,
// from `git` itself, the exact historical facts the registry's notes
// fields assert, so a future rewrite of git history (which would be a
// "silent architectural deletion" of this repository's own provenance,
// baseline section 147) is the only thing that could ever make these
// tests fail.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

describe("UASF-REQ-0001: existing public repository audit is a re-verifiable git-history fact, not a one-time prose claim", () => {
  it("the repository's root commit is the exact single-line-README 'Initial commit' the original audit recorded", () => {
    const rootCommits = git(["rev-list", "--max-parents=0", "HEAD"]).split("\n").filter(Boolean);
    // A genuinely pre-existing, non-recreated repository has exactly ONE
    // root — a second, unrelated root would mean history was spliced or
    // this repository was re-initialized rather than genuinely audited.
    expect(rootCommits).toHaveLength(1);
    const rootSha = rootCommits[0]!;

    const subject = git(["log", "-1", "--format=%s", rootSha]);
    expect(subject).toBe("Initial commit");

    const changedFiles = git(["show", "--stat", "--format=", rootSha])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // Exactly the one-line README the audit described — no other file,
    // no hidden scaffolding predating the audit's own observation.
    expect(changedFiles).toHaveLength(2); // "README.md | 1 +" plus the summary line
    expect(changedFiles[0]).toMatch(/^README\.md\s*\|\s*1\s*\+/);
  });

  it("no branch in this repository diverges from that same single root commit", () => {
    const rootCommits = git(["rev-list", "--max-parents=0", "--all"]).split("\n").filter(Boolean);
    expect(new Set(rootCommits).size).toBe(1);
  });
});

describe("UASF-REQ-0003: baseline specification preservation is verifiable from the frozen git tag, not just asserted in prose", () => {
  it("the 'architecture-baseline-v1' annotated tag exists and resolves to a real, reachable commit", () => {
    const tagNames = git(["tag", "-l"]).split("\n").filter(Boolean);
    expect(tagNames).toContain("architecture-baseline-v1");

    const taggedSha = git(["rev-list", "-n", "1", "architecture-baseline-v1"]);
    expect(taggedSha).toMatch(/^[0-9a-f]{40}$/);
    // The tagged commit must actually be an ancestor of HEAD — a tag
    // pointing at a dangling/orphan commit would not genuinely freeze
    // anything reachable from the branch under review.
    expect(() => git(["merge-base", "--is-ancestor", taggedSha, "HEAD"])).not.toThrow();
  });

  it("the baseline specification file existed, byte-identically sized, at the frozen tag and is unchanged in the working tree since", () => {
    const taggedSha = git(["rev-list", "-n", "1", "architecture-baseline-v1"]);
    const specPathRelative = "specification/UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md";
    const frozenContent = git(["show", `${taggedSha}:${specPathRelative}`]);
    const currentContent = readFileSync(join(repoRoot, specPathRelative), "utf8").replace(/\r?\n$/, "");
    expect(frozenContent).toBe(currentContent.replace(/\r?\n$/, ""));
    expect(frozenContent).toMatch(/^UNIVERSAL AI TECHNOLOGY FACTORY/);
  });

  it("BASELINE.md truthfully names the same tag this test independently verified, not a stale or different one", () => {
    const baselineStatus = readFileSync(join(repoRoot, "specification", "BASELINE.md"), "utf8");
    expect(baselineStatus).toContain("architecture-baseline-v1");
    expect(baselineStatus).toMatch(/Status\s*\|\s*\*\*FROZEN\*\*/);
  });
});
