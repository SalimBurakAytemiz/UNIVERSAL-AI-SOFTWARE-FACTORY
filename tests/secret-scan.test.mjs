import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  findSecretsInText,
  isPlaceholderValue,
  findNonPlaceholderEnvLines,
  scanFile,
  scanGitHistory,
  listHistoricalBlobs
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
    const findings = scanGitHistory(tempRepo);
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

    const findings = scanGitHistory(tempRepo);
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

    const findings = scanGitHistory(tempRepo);
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

    const findings = scanGitHistory(tempRepo);
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

      const findings = scanGitHistory(tempRepo);
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

      const findings = scanGitHistory(tempRepo);
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

      const findings = scanGitHistory(tempRepo);
      expect(findings.some((f) => f.pattern === "OpenAI API key" && f.file.includes("config.json"))).toBe(true);
    }
  );
});

describe("secret-scan: this repository's own known-historical baseline", () => {
  it("the pre-existing historical fixture blob (commit 981f0a4, before secret-scan:allow existed) is baselined precisely, not hidden by a broad exclusion", () => {
    // Scans the REAL repository (default cwd), proving the baseline
    // actually resolves the genuine finding without rewriting git history.
    const findings = scanGitHistory();
    const historicalFixtureFindings = findings.filter((f) => f.file.startsWith("history:tests/secret-scan.test.mjs@"));
    expect(historicalFixtureFindings).toHaveLength(0);
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
