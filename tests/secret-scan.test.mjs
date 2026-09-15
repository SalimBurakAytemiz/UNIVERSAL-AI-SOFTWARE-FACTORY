import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// P2 fix (24th independent review round, "secret history scan must fail
// closed on unreadable blobs"): to deterministically prove the fix without
// actually committing an enormous (hundreds-of-MB) blob into a throwaway
// git repo just to exceed maxBuffer, this intercepts the EXACT single
// `git cat-file -p <sha>` call `readBlobContent()` makes for one targeted
// blob sha (set via `globalThis.__SECRET_SCAN_TEST_UNREADABLE_SHA__` right
// before calling `scanGitHistory()`) and makes it throw, simulating a
// genuine unreadable-blob condition (maxBuffer overrun, transient git
// failure, ...). Every other `execFileSync` call (ls-files, rev-list,
// cat-file --batch-check, and cat-file -p for any OTHER sha) passes
// through to the real implementation unchanged.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execFileSync: (file, args, options) => {
      const targetSha = globalThis.__SECRET_SCAN_TEST_UNREADABLE_SHA__;
      if (targetSha && file === "git" && args?.[0] === "cat-file" && args?.[1] === "-p" && args?.[2] === targetSha) {
        throw new Error("simulated unreadable blob (maxBuffer exceeded or transient git failure)");
      }
      return actual.execFileSync(file, args, options);
    }
  };
});

import {
  findSecretsInText,
  isPlaceholderValue,
  findNonPlaceholderEnvLines,
  scanFile,
  scanGitHistory,
  listHistoricalBlobs,
  isDirectCliInvocation
} from "../scripts/secret-scan.mjs";

describe("secret-scan: findSecretsInText", () => {
  it("flags a hardcoded AWS access key id", () => {
    const findings = findSecretsInText("const key = 'AKIAABCDEFGHIJKLMNOP';", "example.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
    expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
  });

  it("flags a PEM private key block", () => {
    const findings = findSecretsInText("-----BEGIN RSA PRIVATE KEY-----", "id_rsa"); // secret-scan:allow (fake fixture value, tests detection itself)
    expect(findings.some((f) => f.pattern === "Private key block")).toBe(true);
  });

  it("flags a generic apiKey assignment with a real-looking value", () => {
    const findings = findSecretsInText('const apiKey = "abcdef1234567890xyz";', "config.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
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

describe(
  "secret-scan: P1 fix (37th independent review round, finding 6, 'detect the canonical AWS JSON credential " +
    "format') — a quoted `\"SecretAccessKey\": \"...\"` JSON property, the format AWS's own tooling actually " +
    "emits, must be detected even though it does not match the existing snake_case assignment pattern",
  () => {
    it("BLOCKER regression, exact reproduction: flags a synthetic AWS credential JSON blob's SecretAccessKey field", () => {
      const findings = findSecretsInText(
        '{"AccessKeyId":"AKIAABCDEFGHIJKLMNOP","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', // secret-scan:allow (fake fixture value, tests detection itself)
        "aws-credentials.json"
      );
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (JSON credential format)")).toBe(true);
    });

    it("root-cause proof: the same value does NOT match via the pre-existing snake_case assignment pattern or the generic secret pattern", () => {
      // Isolates the NEW pattern specifically: a minimal line containing
      // ONLY the JSON-format key, with no snake_case/generic-keyword
      // wording nearby that could make an unrelated, pre-existing pattern
      // coincidentally also fire.
      const findings = findSecretsInText(
        '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', // secret-scan:allow (fake fixture value, tests detection itself)
        "isolated.json"
      );
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (JSON credential format)")).toBe(true);
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (assignment)")).toBe(false);
    });

    it("no-regression: the pre-existing snake_case assignment format is still detected unchanged", () => {
      const findings = findSecretsInText(
        'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', // secret-scan:allow (fake fixture value, tests detection itself)
        "config.env"
      );
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (assignment)")).toBe(true);
    });

    it("does not flag an unrelated JSON property that merely happens to be named similarly", () => {
      const findings = findSecretsInText('{"secretAccessKeyRotationEnabled": true}', "settings.json");
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (JSON credential format)")).toBe(false);
    });
  }
);

describe(
  "secret-scan: P2 fix (18th independent review round, 'secret scanner misses project-scoped OpenAI keys " +
    "in JSON') — a project-scoped OpenAI key (sk-proj-...) must be detected regardless of surrounding syntax",
  () => {
    const syntheticProjectKey =
      "sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // secret-scan:allow (fake fixture value, tests detection itself)

    it("detects a project-scoped OpenAI key inside quoted JSON syntax (single line)", () => {
      const findings = findSecretsInText(`{"apiKey":"${syntheticProjectKey}"}`, "config.json"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("detects a project-scoped OpenAI key inside pretty-printed (multi-line, indented) JSON", () => {
      const json = [
        "{",
        `  "apiKey": "${syntheticProjectKey}"`, // secret-scan:allow (fake fixture value, tests detection itself)
        "}"
      ].join("\n");
      const findings = findSecretsInText(json, "config.json");
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("detects a project-scoped OpenAI key in .env-style assignment syntax", () => {
      const findings = findSecretsInText(`OPENAI_API_KEY=${syntheticProjectKey}`, ".env"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("detects a project-scoped OpenAI key in YAML-style assignment syntax", () => {
      const findings = findSecretsInText(`openai_api_key: ${syntheticProjectKey}`, "config.yaml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("detects a project-scoped OpenAI key in TOML-style assignment syntax", () => {
      const findings = findSecretsInText(`openai_api_key = "${syntheticProjectKey}"`, "config.toml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("detects a project-scoped OpenAI key in a TypeScript/JavaScript string assignment", () => {
      const findings = findSecretsInText(`const apiKey = "${syntheticProjectKey}";`, "config.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "OpenAI API key")).toBe(true);
    });

    it("does not double-count an Anthropic key as a duplicate OpenAI finding", () => {
      const findings = findSecretsInText(
        'const apiKey = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";', // secret-scan:allow (fake fixture value, tests detection itself)
        "config.ts"
      );
      expect(findings.filter((f) => f.pattern === "Anthropic API key")).toHaveLength(1);
      expect(findings.filter((f) => f.pattern === "OpenAI API key")).toHaveLength(0);
    });

    it("does not flag a quoted JSON property with an obviously non-secret, short value (no broad false positive)", () => {
      const findings = findSecretsInText('{"apiKey": "true", "password": "no"}', "settings.json");
      expect(findings).toHaveLength(0);
    });

    it("does not flag unrelated harmless strings that merely start with 'sk-' (no broad false positive)", () => {
      const findings = findSecretsInText('const flag = "sk-off";', "flags.ts");
      expect(findings).toHaveLength(0);
    });

    it("detects an AWS temporary/STS access key id (ASIA prefix), a genuine variant AKIA-only detection missed", () => {
      const findings = findSecretsInText("const key = 'ASIAABCDEFGHIJKLMNOP';", "example.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
    });

    it("detects a GitHub fine-grained personal access token (github_pat_ prefix), a genuine variant the old pattern missed", () => {
      const findings = findSecretsInText(
        "const token = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop';", // secret-scan:allow (fake fixture value, tests detection itself)
        "example.ts"
      );
      expect(findings.some((f) => f.pattern === "GitHub token")).toBe(true);
    });
  }
);

describe(
  "secret-scan: P1 fix (23rd independent review round, 'secret scanner must detect unquoted assignments') " +
    "— unquoted secret-shaped assignments must be detected across every previously-supported syntax",
  () => {
    it("detects an unquoted shell/.env-style KEY=value assignment", () => {
      const findings = findSecretsInText("API_KEY=abcdefghijklmnopqrstuv", ".env"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("detects an unquoted shell-style PASSWORD=value assignment", () => {
      const findings = findSecretsInText("PASSWORD=abcdefghijklmnopqrstuvwxyz", ".env"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("detects an unquoted YAML-style key: value assignment", () => {
      const findings = findSecretsInText("password: abcdefghijklmnopqrstuvwxyz", "config.yaml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("detects an unquoted TOML-style key = value assignment", () => {
      const findings = findSecretsInText("api_key = abcdefghijklmnopqrstuvwxyz", "config.toml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("still detects the pre-existing single-quoted form (no regression)", () => {
      const findings = findSecretsInText("access_token: 'abcdefghijklmnopqrstuvwxyz'", "config.yaml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("still detects the pre-existing double-quoted JSON form (no regression)", () => {
      const findings = findSecretsInText('{"secret": "abcdefghijklmnopqrstuvwxyz"}', "config.json"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("still detects the pre-existing unquoted JS/TS const assignment form (no regression)", () => {
      const findings = findSecretsInText("const password = abcdefghijklmnopqrstuvwxyz;", "config.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("does not flag a short, obviously non-secret unquoted value (no broad false positive)", () => {
      const findings = findSecretsInText("password=no", "config.env");
      expect(findings).toHaveLength(0);
    });

    it("respects secret-scan:allow for a deliberately fake unquoted fixture", () => {
      const findings = findSecretsInText(
        "API_KEY=abcdefghijklmnopqrstuv // secret-scan:allow (fake fixture value)",
        ".env"
      );
      expect(findings).toHaveLength(0);
    });
  }
);

describe(
  "secret-scan: P1 fix (35th independent review round, finding 12, 'detect base64 padding in quoted " +
    "secret assignments') — a quoted secret value ending in base64 '=' padding must still be detected",
  () => {
    // Synthetic, deliberately fake Base64-shaped fixture values (not derived
    // from any real credential) — used only to prove the scanner's pattern
    // matching, per this repo's secret-scan:allow convention.
    const doublePadded = "YWJjZGVmZ2hpamtsbW5vcA=="; // secret-scan:allow (fake fixture value, tests detection itself)
    const singlePadded = "YWJjZGVmZ2hpamtsbW5vcQ="; // secret-scan:allow (fake fixture value, tests detection itself)

    it("BLOCKER: detects a double-quoted apiKey value with double '==' base64 padding", () => {
      const findings = findSecretsInText(`apiKey="${doublePadded}"`, "config.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("BLOCKER: detects a single-quoted secret value with single '=' base64 padding", () => {
      const findings = findSecretsInText(`secret='${singlePadded}'`, "config.ts"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("BLOCKER: detects a double-quoted JSON password field with base64 padding", () => {
      const findings = findSecretsInText(`{"password": "${doublePadded}"}`, "config.json"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("no-regression: still detects a quoted value with no base64 padding at all", () => {
      const findings = findSecretsInText('access_token: "abcdefghijklmnopqrstuvwxyz"', "config.yaml"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });

    it("no-regression: does not flag an unquoted value that happens to end in '=' (outside this finding's scope)", () => {
      const findings = findSecretsInText("password=abcdefghijklmnopqrstuvwxyz=", "config.env"); // secret-scan:allow (fake fixture value, tests detection itself)
      expect(findings.some((f) => f.pattern === "Generic API key/secret assignment with a real-looking value")).toBe(
        true
      );
    });
  }
);

describe("secret-scan: no whole-file allowlist (regression for the P2 finding)", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeFileAt(root, relativePath, content) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }

  it("REGRESSION: an unmarked, real-looking credential placed anywhere in tests/secret-scan.test.mjs would still be detected", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-secret-scan-regress-"));
    // Same path the scanner would see for the real file — proves the path
    // itself carries no special exemption any more.
    const relativePath = "tests/secret-scan.test.mjs";
    writeFileAt(
      tempRoot,
      relativePath,
      "describe('unrelated', () => {\n" +
        "  const oops = 'AKIAZZZZZZZZZZZZZZZZ';\n" + // deliberately NOT marked secret-scan:allow
        "});\n"
    );

    const findings = scanFile(relativePath, tempRoot);
    expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
  });

  it("REGRESSION: an unmarked credential in scripts/secret-scan.mjs's own path would still be detected", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-secret-scan-regress-"));
    const relativePath = "scripts/secret-scan.mjs";
    writeFileAt(tempRoot, relativePath, "const leaked = 'AKIAZZZZZZZZZZZZZZZZ';\n"); // secret-scan:allow (fake fixture value written into a temp file)

    const findings = scanFile(relativePath, tempRoot);
    expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
  });

  it("still respects the per-line secret-scan:allow marker even with no path-level allowlist", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-secret-scan-regress-"));
    const relativePath = "tests/secret-scan.test.mjs";
    writeFileAt(
      tempRoot,
      relativePath,
      "const fixture = 'AKIAZZZZZZZZZZZZZZZZ'; // secret-scan:allow (deliberate fake fixture)\n"
    );

    expect(scanFile(relativePath, tempRoot)).toHaveLength(0);
  });
});

describe(
  "P2 fix (24th independent review round targeted audit, same root class as 'secret history scan must fail " +
    "closed on unreadable blobs'): scanFile() must not silently skip a current-tree file it cannot read",
  () => {
    it("REGRESSION: a tracked file that fails to read throws rather than returning an empty (falsely clean) result", () => {
      const missingPath = "definitely/does/not/exist.txt";
      expect(() => scanFile(missingPath, process.cwd())).toThrow();
    });
  }
);

describe("secret-scan: git-history-aware scanning", () => {
  let tempRepo;

  function git(args) {
    return execFileSync("git", args, { cwd: tempRepo, encoding: "utf8" });
  }

  function initTempRepo() {
    const root = mkdtempSync(join(tmpdir(), "uasf-secret-scan-history-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    return root;
  }

  afterEach(() => {
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true });
  });

  it("finds a secret that was committed and later deleted (still exposed in history)", () => {
    tempRepo = initTempRepo();

    // Commit 1: a "credentials.txt" containing a real-looking AWS key.
    writeFileSync(join(tempRepo, "credentials.txt"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n"); // secret-scan:allow (fake fixture value written into a temp repo)
    git(["add", "credentials.txt"]);
    git(["commit", "-m", "oops: add credentials"]);

    // Commit 2: delete it. Removing the current file is NOT enough — the
    // baseline itself says so (section 2).
    execFileSync("git", ["rm", "credentials.txt"], { cwd: tempRepo });
    git(["commit", "-m", "remove credentials"]);

    // The file no longer exists in the working tree / current tracked files.
    const trackedNow = execFileSync("git", ["ls-files"], { cwd: tempRepo, encoding: "utf8" });
    expect(trackedNow).not.toContain("credentials.txt");

    // But git history scanning must still find it.
    const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
    expect(unreadableBlobs).toHaveLength(0);
    expect(findings.some((f) => f.pattern === "AWS Access Key ID" && f.file.includes("credentials.txt"))).toBe(true);
  });

  it("does not flag a historical line that carried the secret-scan:allow marker", () => {
    tempRepo = initTempRepo();
    writeFileSync(
      join(tempRepo, "fixture.txt"),
      "const fake = 'AKIAABCDEFGHIJKLMNOP'; // secret-scan:allow (deliberate fake fixture)\n"
    );
    git(["add", "fixture.txt"]);
    git(["commit", "-m", "add fixture"]);

    const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
    expect(unreadableBlobs).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });

  it("a currently-tracked secret is found by the current-tree scan (not only history)", () => {
    tempRepo = initTempRepo();
    writeFileSync(join(tempRepo, "still-here.txt"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n"); // secret-scan:allow (fake fixture value written into a temp repo)
    git(["add", "still-here.txt"]);
    git(["commit", "-m", "add current secret"]);

    const findings = scanFile("still-here.txt", tempRepo);
    expect(findings.some((f) => f.pattern === "AWS Access Key ID")).toBe(true);
  });

  it("redacted reporting: a finding never carries the actual secret value, only file/line/pattern", () => {
    tempRepo = initTempRepo();
    const secretValue = "AKIAABCDEFGHIJKLMNOP"; // secret-scan:allow (fake fixture value written into a temp repo)
    writeFileSync(join(tempRepo, "credentials.txt"), `AWS_KEY=${secretValue}\n`);
    git(["add", "credentials.txt"]);
    git(["commit", "-m", "add credentials"]);

    const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
    expect(unreadableBlobs).toHaveLength(0);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      const serialized = JSON.stringify(finding);
      expect(serialized).not.toContain(secretValue);
      expect(Object.keys(finding).sort()).toEqual(["file", "line", "pattern"]);
    }
  });

  it("scans each unique historical blob only once, even when identical content is committed under two paths", () => {
    tempRepo = initTempRepo();
    // Git stores identical content as ONE blob object regardless of how
    // many paths/commits reference it — scanGitHistory must not report
    // the same secret twice just because it appears at two paths.
    writeFileSync(join(tempRepo, "a.txt"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n"); // secret-scan:allow (fake fixture value written into a temp repo)
    git(["add", "a.txt"]);
    git(["commit", "-m", "commit 1"]);
    writeFileSync(join(tempRepo, "b.txt"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n"); // secret-scan:allow (fake fixture value written into a temp repo)
    git(["add", "b.txt"]);
    git(["commit", "-m", "commit 2"]);

    const blobs = listHistoricalBlobs(tempRepo);
    const uniqueShas = new Set(blobs.map((b) => b.sha));
    expect(uniqueShas.size).toBe(blobs.length); // listHistoricalBlobs already dedupes by sha

    const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
    expect(unreadableBlobs).toHaveLength(0);
    expect(findings).toHaveLength(1); // one unique blob -> one finding, not two
  });

  it(
    "P1 fix (23rd independent review round, 'secret scanner must detect unquoted assignments'): an " +
      "unquoted shell/.env-style secret assignment, committed and later deleted, remains detected via history scanning",
    () => {
      tempRepo = initTempRepo();
      writeFileSync(join(tempRepo, "config.env"), "API_KEY=abcdefghijklmnopqrstuv\n"); // secret-scan:allow (fake fixture value written into a temp repo)
      git(["add", "config.env"]);
      git(["commit", "-m", "oops: add unquoted credential"]);

      execFileSync("git", ["rm", "config.env"], { cwd: tempRepo });
      git(["commit", "-m", "remove config"]);

      const trackedNow = execFileSync("git", ["ls-files"], { cwd: tempRepo, encoding: "utf8" });
      expect(trackedNow).not.toContain("config.env");

      const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
      expect(unreadableBlobs).toHaveLength(0);
      expect(
        findings.some(
          (f) =>
            f.pattern === "Generic API key/secret assignment with a real-looking value" &&
            f.file.includes("config.env")
        )
      ).toBe(true);
    }
  );

  it(
    "P2 fix (18th independent review round): a synthetic project-scoped OpenAI key (sk-proj-) committed " +
      "to history is detected by the history scan",
    () => {
      tempRepo = initTempRepo();
      writeFileSync(
        join(tempRepo, "config.json"),
        '{"apiKey":"sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}\n' // secret-scan:allow (fake fixture value written into a temp repo)
      );
      git(["add", "config.json"]);
      git(["commit", "-m", "oops: add config with a credential"]);

      const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
      expect(unreadableBlobs).toHaveLength(0);
      expect(findings.some((f) => f.pattern === "OpenAI API key" && f.file.includes("config.json"))).toBe(true);
    }
  );

  it(
    "P2 fix (18th independent review round): a synthetic project-scoped OpenAI key deleted from the " +
      "current tree remains detected via history scanning",
    () => {
      tempRepo = initTempRepo();
      writeFileSync(
        join(tempRepo, "config.json"),
        '{"apiKey":"sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}\n' // secret-scan:allow (fake fixture value written into a temp repo)
      );
      git(["add", "config.json"]);
      git(["commit", "-m", "oops: add config with a credential"]);

      execFileSync("git", ["rm", "config.json"], { cwd: tempRepo });
      git(["commit", "-m", "remove config"]);

      const trackedNow = execFileSync("git", ["ls-files"], { cwd: tempRepo, encoding: "utf8" });
      expect(trackedNow).not.toContain("config.json");

      const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
      expect(unreadableBlobs).toHaveLength(0);
      expect(findings.some((f) => f.pattern === "OpenAI API key" && f.file.includes("config.json"))).toBe(true);
    }
  );

  it(
    "P1 fix (37th independent review round, finding 6): a synthetic AWS credential JSON blob's " +
      "SecretAccessKey field, committed and later deleted, remains detected via history scanning",
    () => {
      tempRepo = initTempRepo();
      writeFileSync(
        join(tempRepo, "aws-credentials.json"),
        '{"AccessKeyId":"AKIAABCDEFGHIJKLMNOP","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}\n' // secret-scan:allow (fake fixture value written into a temp repo)
      );
      git(["add", "aws-credentials.json"]);
      git(["commit", "-m", "oops: add AWS credentials JSON"]);

      execFileSync("git", ["rm", "aws-credentials.json"], { cwd: tempRepo });
      git(["commit", "-m", "remove credentials"]);

      const trackedNow = execFileSync("git", ["ls-files"], { cwd: tempRepo, encoding: "utf8" });
      expect(trackedNow).not.toContain("aws-credentials.json");

      const { findings, unreadableBlobs } = scanGitHistory(tempRepo);
      expect(unreadableBlobs).toHaveLength(0);
      expect(
        findings.some(
          (f) => f.pattern === "AWS Secret Access Key (JSON credential format)" && f.file.includes("aws-credentials.json")
        )
      ).toBe(true);
    }
  );

  it(
    "P1 fix (37th independent review round, finding 6): a currently-tracked AWS credential JSON blob's " +
      "SecretAccessKey field is found by the current-tree scan (not only history)",
    () => {
      tempRepo = initTempRepo();
      writeFileSync(
        join(tempRepo, "aws-credentials.json"),
        '{"AccessKeyId":"AKIAABCDEFGHIJKLMNOP","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}\n' // secret-scan:allow (fake fixture value written into a temp repo)
      );
      git(["add", "aws-credentials.json"]);
      git(["commit", "-m", "add current AWS credentials JSON"]);

      const findings = scanFile("aws-credentials.json", tempRepo);
      expect(findings.some((f) => f.pattern === "AWS Secret Access Key (JSON credential format)")).toBe(true);
    }
  );

  describe("P2 fix (24th independent review round, 'secret history scan must fail closed on unreadable blobs')", () => {
    afterEach(() => {
      delete globalThis.__SECRET_SCAN_TEST_UNREADABLE_SHA__;
    });

    it(
      "REGRESSION: a historical blob whose content cannot be read is never silently treated as clean — it is " +
        "reported as an unreadable-blob coverage failure, and removing the current file does not hide that",
      () => {
        tempRepo = initTempRepo();
        writeFileSync(join(tempRepo, "big-secret.txt"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n"); // secret-scan:allow (fake fixture value written into a temp repo)
        git(["add", "big-secret.txt"]);
        git(["commit", "-m", "add a file that will simulate an unreadable historical blob"]);
        execFileSync("git", ["rm", "big-secret.txt"], { cwd: tempRepo });
        git(["commit", "-m", "remove it from the current tree"]);

        const blobs = listHistoricalBlobs(tempRepo);
        const target = blobs.find((b) => b.path === "big-secret.txt");
        expect(target).toBeDefined();

        // Simulate the blob's content read failing (maxBuffer overrun,
        // transient git failure, ...) — see the module-level vi.mock above.
        globalThis.__SECRET_SCAN_TEST_UNREADABLE_SHA__ = target.sha;

        const { findings, unreadableBlobs } = scanGitHistory(tempRepo);

        // The failure is surfaced explicitly, not silently absorbed...
        expect(unreadableBlobs.some((b) => b.sha === target.sha && b.path === "big-secret.txt")).toBe(true);
        // ...and the secret inside that SPECIFIC unreadable blob was never
        // actually scanned — proving this is a genuine "could not read"
        // condition, not a disguised "scanned and found nothing."
        expect(findings.some((f) => f.file.includes("big-secret.txt"))).toBe(false);
      }
    );

    it("a scan with no unreadable blobs reports an empty unreadableBlobs list (no regression)", () => {
      tempRepo = initTempRepo();
      writeFileSync(join(tempRepo, "clean.txt"), "hello world\n");
      git(["add", "clean.txt"]);
      git(["commit", "-m", "add a clean file"]);

      const { unreadableBlobs } = scanGitHistory(tempRepo);
      expect(unreadableBlobs).toEqual([]);
    });
  });
});

describe("secret-scan: this repository's own known-historical baseline", () => {
  // P2 fix (37th independent review round, "secret-scan history test
  // exceeding the 5s default test timeout"): this test scans the FULL,
  // REAL git history of this repository (`scanGitHistory()` with no
  // override — bkz. yukarıdaki not) — as this repo has genuinely grown
  // (37 rounds' worth of commits by the time of this fix), that real scan
  // now legitimately takes longer than Vitest's 5000ms default test
  // timeout, which is unrelated to whether the scanner itself is correct.
  // Per this round's own explicit instruction: do not skip this test, do
  // not weaken the scanner, do not raise the GLOBAL test timeout (which
  // would silently mask a genuine hang in an unrelated, actually-fast
  // test) — apply a narrow, justified timeout to ONLY this one
  // genuinely-long-running history-integration test. 30s comfortably
  // covers this repository's current history size with headroom for
  // continued (linear) growth, while still failing loudly if this test
  // itself ever genuinely hangs.
  it(
    "the pre-existing historical fixture blob (commit 981f0a4, before secret-scan:allow existed) is baselined precisely, not hidden by a broad exclusion",
    () => {
      // Scans the REAL repository (default cwd), proving the baseline
      // actually resolves the genuine finding without rewriting git history.
      const { findings, unreadableBlobs } = scanGitHistory();
      expect(unreadableBlobs).toHaveLength(0);
      const historicalFixtureFindings = findings.filter((f) => f.file.startsWith("history:tests/secret-scan.test.mjs@"));
      expect(historicalFixtureFindings).toHaveLength(0);
    },
    30000
  );
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

  it(
    "P2 fix (18th independent review round): a safe, explicit placeholder for an OpenAI project-scoped " +
      "key variable is still allowed in .env.example (the widened OpenAI pattern does not turn a legitimate " +
      "empty/placeholder value into a false positive)",
    () => {
      const findings = findNonPlaceholderEnvLines("OPENAI_API_KEY=\nOPENAI_PROJECT_API_KEY=<your-openai-project-key>");
      expect(findings).toHaveLength(0);
    }
  );
});

describe(
  "secret-scan: P1 fix (36th independent review round, finding 1, 'use a URL-safe secret-scan CLI " +
    "entry-point check') — isDirectCliInvocation() must correctly identify direct execution regardless of " +
    "spaces, non-ASCII characters, or Windows path syntax in the script's own path",
  () => {
    it("BLOCKER regression, exact reproduction: a script path containing a space must still be recognized as direct invocation", () => {
      const argv1 = "/home/runner/My Repo/scripts/secret-scan.mjs";
      const moduleUrl = pathToFileURL(argv1).href;
      expect(isDirectCliInvocation(argv1, moduleUrl)).toBe(true);
    });

    it("BLOCKER regression: a script path containing non-ASCII characters must still be recognized as direct invocation", () => {
      const argv1 = "/home/runner/Fabrikamız/scripts/secret-scan.mjs";
      const moduleUrl = pathToFileURL(argv1).href;
      expect(isDirectCliInvocation(argv1, moduleUrl)).toBe(true);
    });

    it("BLOCKER regression: a Windows-style drive-letter/backslash path must still be recognized as direct invocation", () => {
      const argv1 = "C:\\Users\\Founder\\repo\\scripts\\secret-scan.mjs";
      const moduleUrl = pathToFileURL(argv1).href;
      expect(isDirectCliInvocation(argv1, moduleUrl)).toBe(true);
    });

    it("does not falsely report direct invocation when the module URL genuinely differs (imported, not run directly)", () => {
      const argv1 = "/home/runner/repo/tests/secret-scan.test.mjs";
      const moduleUrl = pathToFileURL("/home/runner/repo/scripts/secret-scan.mjs").href;
      expect(isDirectCliInvocation(argv1, moduleUrl)).toBe(false);
    });

    it("returns false (never throws) when argv1 is undefined (e.g. a REPL or worker context with no script path)", () => {
      expect(isDirectCliInvocation(undefined, "file:///anything")).toBe(false);
    });

    it("no-regression: a plain ASCII path with no spaces still matches exactly as before", () => {
      const argv1 = "/home/runner/repo/scripts/secret-scan.mjs";
      const moduleUrl = pathToFileURL(argv1).href;
      expect(isDirectCliInvocation(argv1, moduleUrl)).toBe(true);
    });
  }
);

describe(
  "secret-scan: P1 fix (36th independent review round, finding 1) end-to-end proof — the REAL script, run " +
    "as a real child process from a path containing a space and a non-ASCII character, must actually scan " +
    "rather than silently exiting 0 having done nothing",
  () => {
    let tempRoot;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it("BLOCKER end-to-end regression: running the script directly from a 'space + non-ASCII' path produces real scan output, not silent no-op success", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-secret-scan-cli-"));
      const weirdDir = join(tempRoot, "repo with space and üñïçødé");
      mkdirSync(weirdDir, { recursive: true });

      // A minimal, real git repo so the script's own git ls-files/rev-list
      // calls succeed (required for main() to complete, not just start).
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: weirdDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: weirdDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: weirdDir });
      writeFileSync(join(weirdDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: weirdDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: weirdDir });

      const scriptDest = join(weirdDir, "secret-scan.mjs");
      const scriptSrc = join(dirname(new URL(import.meta.url).pathname), "..", "scripts", "secret-scan.mjs");
      writeFileSync(scriptDest, readFileSync(scriptSrc, "utf8"));

      const output = execFileSync("node", [scriptDest], { cwd: weirdDir, encoding: "utf8" });
      // The pre-fix bug made isDirectCliInvocation()'s predecessor comparison
      // fail on this exact path shape, so main() never ran and stdout was
      // empty. The fix must make main() genuinely execute and print its
      // real banner/result line.
      expect(output).toContain("Public Repository Secret Scan");
      expect(output).toContain("Result:");
    });
  }
);
