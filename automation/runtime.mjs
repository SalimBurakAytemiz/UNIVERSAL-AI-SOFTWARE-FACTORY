import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export async function readJson(file, fallback) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function lock(file) {
  await mkdir(path.dirname(file), { recursive: true });
  // Türkçe: Kilit otomatik çalınmaz; ikinci supervisor aynı state'i değiştiremez.
  const handle = await open(file, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  return async () => { await handle.close(); await unlink(file); };
}

export function run(command, args = [], { cwd, input, env = process.env, timeoutMs = 120000, maxBytes = 2_000_000 } = {}) {
  return new Promise(resolve => {
    // Türkçe: Windows .cmd desteği için veriler tek tırnakla kaçırılır; prompt shell'e girmez.
    let executable = command, argv = args;
    if (process.platform === "win32" && !path.isAbsolute(command)) {
      const searchPath = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
      executable = searchPath.split(path.delimiter).flatMap(dir => [".exe", ".cmd", ".bat", ""].map(ext => path.join(dir, command + ext))).find(file => existsSync(file)) || command;
    }
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
      const quote = s => "'" + String(s).replaceAll("'", "''") + "'";
      const script = `& ${quote(executable)} ${args.map(quote).join(" ")}\nif ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
      executable = "powershell.exe";
      argv = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    }
    const child = spawn(executable, argv, { cwd, env, shell: false, windowsHide: true });
    let stdout = "", stderr = "", timedOut = false, overflow = false;
    const kill = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.code || "SPAWN_ERROR" }); });
    child.stdout.on("data", data => { stdout += data; if (stdout.length + stderr.length > maxBytes) { overflow = true; kill(); } });
    child.stderr.on("data", data => { stderr += data; if (stdout.length + stderr.length > maxBytes) { overflow = true; kill(); } });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, overflow }); });
  });
}

export class Stop extends Error { constructor(message) { super(message); this.name = "Stop"; } }
export class Unavailable extends Error { constructor(message, retryAt = null) { super(message); this.name = "Unavailable"; this.retryAt = retryAt; } }
export class ProviderError extends Error {
  constructor(kind, retryAfterMs = 0) { super(kind); this.kind = kind; this.retryAfterMs = retryAfterMs; }
}

export function classifyFailure(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.timedOut) return "TIMEOUT";
  if (result.overflow) return "OUTPUT_LIMIT";
  if (/quota|out of credits|usage limit|hit your limit|insufficient.credit/i.test(text)) return "QUOTA";
  if (/rate[ _-]?limit|\b429\b|too many requests/i.test(text)) return "RATE_LIMIT";
  if (/unauthorized|authentication|not.logged.in|\b401\b|\b403\b/i.test(text)) return "AUTH";
  if (/not found|not recognized|ENOENT|CommandNotFound|unavailable|\b404\b/i.test(text)) return "UNAVAILABLE";
  return "TRANSIENT";
}

export function parseObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "");
  try {
    const value = JSON.parse(cleaned);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ProviderError("INVALID_RESPONSE"); }
}
