import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { isolatedGitEnvironment } from "../../../dist/kernel/git-environment.js";
import { directories } from "../../../dist/kernel/xdg.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(join(SCRIPT_DIR, "../../.."));
const BIN = join(ENGINE_ROOT, "bin", "kanthord.mjs");

const OAUTH_TYPE = "oauth";
const REFRESH_MARGIN_MS = 10 * 60000;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 16;
const EVAL_DIR_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;
const BLEND_INPUT_WEIGHT = 20;
const BLEND_CACHE_READ_WEIGHT = 80;
const BLEND_OUTPUT_WEIGHT = 2;
const CENTS_PER_DOLLAR = 100;
const MICRO_SCALE = 1000000;
const MAX_WALL = "2h";
const MAX_WALL_MS = 7200000;
const WALL_UNITS = { s: 1000, m: 60000, h: 3600000 };
const USD_SUFFIX = "usd";
const BREACH_CREDENTIAL = "credential";
const BREACH_AUTH_FILE = "auth_file";
const PROFILE_SWE = "swe@1";
const EVAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const HEX_COMMIT_RE = /^[0-9a-f]{40}$/;
const KIND_VALUES = ["backend", "frontend"];
const END_COMPLETED = "completed";
const EXIT_OK = 0;
const EXIT_STOP = 1;
const EXIT_CAP = 4;
const EXIT_BUDGET_END = 5;
const EXIT_PROMPT_PATH = 2;
const EXIT_75 = 75;

function randomName() {
  let name = "";
  const len = RANDOM_ALPHABET.length;
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    name += RANDOM_ALPHABET[Math.floor(Math.random() * len)];
  }
  return name;
}

function parseDuration(value) {
  const m = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * WALL_UNITS[m[2]];
}

function parseUsdCents(value) {
  if (typeof value !== "string") return null;
  if (!value.endsWith(USD_SUFFIX)) return null;
  const num = value.slice(0, -USD_SUFFIX.length);
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(num)) return null;
  const f = Number(num);
  if (f <= 0) return null;
  return Math.round(f * CENTS_PER_DOLLAR);
}

function parseModelString(model) {
  const colonIdx = model.indexOf(":");
  const base = colonIdx === -1 ? model : model.slice(0, colonIdx);
  const slashIdx = base.indexOf("/");
  if (slashIdx === -1) return null;
  return { provider: base.slice(0, slashIdx), id: base.slice(slashIdx + 1) };
}

export function validateCase(json) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return "case.json must be a JSON object";
  }
  const required = ["kind", "commit", "wall", "usd", "allowed"];
  for (const key of required) {
    if (!(key in json)) return `case.json missing key: ${key}`;
  }
  const extra = Object.keys(json).filter((k) => !required.includes(k));
  if (extra.length > 0) return `case.json has unexpected key: ${extra[0]}`;
  if (!KIND_VALUES.includes(json.kind)) {
    return `case.json kind must be backend or frontend`;
  }
  if (!HEX_COMMIT_RE.test(json.commit)) {
    return `case.json commit must be a full hexadecimal commit id`;
  }
  const wallMs = parseDuration(json.wall);
  if (wallMs === null) return `case.json wall is not a valid duration`;
  if (wallMs > MAX_WALL_MS) return `case.json wall exceeds ${MAX_WALL}`;
  if (parseUsdCents(json.usd) === null)
    return `case.json usd is not a valid cost budget`;
  if (!Array.isArray(json.allowed) || json.allowed.length === 0) {
    return `case.json allowed must be a non-empty array`;
  }
  for (const glob of json.allowed) {
    if (typeof glob !== "string")
      return `case.json allowed entry must be a string`;
  }
  return null;
}

export function validateConfig(json) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { key: null, message: "config.json must be a JSON object" };
  }
  const required = [
    "cap_usd",
    "base_model",
    "model",
    "judge_model",
    "judge_usd",
    "repeats",
    "gate_share",
  ];
  for (const key of required) {
    if (!(key in json))
      return { key, message: `config.json missing key: ${key}` };
  }
  const extra = Object.keys(json).filter((k) => !required.includes(k));
  if (extra.length > 0)
    return {
      key: extra[0],
      message: `config.json has unexpected key: ${extra[0]}`,
    };
  if (typeof json.cap_usd !== "number" || json.cap_usd <= 0) {
    return {
      key: "cap_usd",
      message: "config.json cap_usd must be a number above 0",
    };
  }
  if (typeof json.base_model !== "string" || json.base_model.includes(":")) {
    return {
      key: "base_model",
      message:
        "config.json base_model must be <provider>/<model> with no level",
    };
  }
  if (parseModelString(json.base_model) === null) {
    return {
      key: "base_model",
      message: "config.json base_model is not a valid model string",
    };
  }
  if (typeof json.model !== "string" || !json.model.includes(":")) {
    return {
      key: "model",
      message: "config.json model must be <provider>/<model>:<level>",
    };
  }
  if (typeof json.judge_model !== "string" || !json.judge_model.includes(":")) {
    return {
      key: "judge_model",
      message: "config.json judge_model must be <provider>/<model>:<level>",
    };
  }
  if (parseUsdCents(json.judge_usd) === null) {
    return {
      key: "judge_usd",
      message: "config.json judge_usd must be a valid cost budget",
    };
  }
  if (!Number.isInteger(json.repeats) || json.repeats < 2) {
    return {
      key: "repeats",
      message: "config.json repeats must be an integer of at least 2",
    };
  }
  if (
    typeof json.gate_share !== "number" ||
    json.gate_share <= 0 ||
    json.gate_share > 1
  ) {
    return {
      key: "gate_share",
      message: "config.json gate_share must be a number above 0 and at most 1",
    };
  }
  return null;
}

export function highestTierCost(cost) {
  if (!cost.tiers || cost.tiers.length === 0) return cost;
  const best = cost.tiers.reduce((a, b) =>
    b.inputTokensAbove > a.inputTokensAbove ? b : a,
  );
  return {
    input: best.input,
    output: best.output,
    cacheRead: best.cacheRead,
    cacheWrite: best.cacheWrite ?? 0,
  };
}

export function blend100(cost) {
  const c = highestTierCost(cost);
  const inputMicro = Math.round(c.input * MICRO_SCALE);
  const outputMicro = Math.round(c.output * MICRO_SCALE);
  const cacheReadMicro = Math.round(c.cacheRead * MICRO_SCALE);
  return (
    BLEND_CACHE_READ_WEIGHT * cacheReadMicro +
    BLEND_INPUT_WEIGHT * inputMicro +
    BLEND_OUTPUT_WEIGHT * outputMicro
  );
}

export function scaleUsdCents(usdCents, m100blend, base100blend) {
  const num = usdCents * m100blend;
  const denom = base100blend;
  return Math.ceil(num / denom);
}

export async function readModelPrices(createRuntimeFn) {
  const create = createRuntimeFn ?? ((opts) => ModelRuntime.create(opts));
  const runtime = await create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return {
    getModel: (provider, id) => runtime.getModel(provider, id),
  };
}

function getModelCost(runtime, modelStr) {
  const parsed = parseModelString(modelStr);
  if (!parsed) return null;
  const model = runtime.getModel(parsed.provider, parsed.id);
  if (!model) return null;
  return model.cost;
}

export async function refreshAuth(
  authPath,
  provider,
  minOAuthValidityMs,
  createRuntimeFn,
) {
  const create = createRuntimeFn ?? ((opts) => ModelRuntime.create(opts));
  const runtime = await create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const entries = await runtime.listCredentials();
  const isOAuth = entries.some(
    (entry) => entry.providerId === provider && entry.type === OAUTH_TYPE,
  );
  if (!isOAuth) return;
  const result = await runtime.getAuth(provider, { minOAuthValidityMs });
  if (result === undefined) throw new Error("refresh returned no result");
}

function fileDigest(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

export function captureAuthState(authPath) {
  const st = lstatSync(authPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const digest = fileDigest(authPath);
  const mode = st.mode & 0o777;
  const configDir = dirname(authPath);
  const entries = readdirSync(configDir).sort();
  return { digest, mode, entries };
}

export function checkAuthFileBreach(authPath, saved) {
  const current = captureAuthState(authPath);
  if (!current) return true;
  if (current.digest !== saved.digest) return true;
  if (current.mode !== saved.mode) return true;
  if (current.mode !== AUTH_FILE_MODE) return true;
  if (current.entries.length !== saved.entries.length) return true;
  for (let i = 0; i < current.entries.length; i++) {
    if (current.entries[i] !== saved.entries[i]) return true;
  }
  return false;
}

function extractCredentialValues(authPath) {
  const values = [];
  let raw;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return values;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return values;
  }
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "api_key" && typeof entry.key === "string") {
      values.push(entry.key);
    } else if (entry.type === OAUTH_TYPE) {
      if (typeof entry.refresh === "string") values.push(entry.refresh);
      if (typeof entry.access === "string") values.push(entry.access);
    }
  }
  return values;
}

export function countCredentialInText(text, credValues) {
  let count = 0;
  for (const val of credValues) {
    if (val.length === 0) continue;
    let idx = 0;
    while ((idx = text.indexOf(val, idx)) !== -1) {
      count++;
      idx += val.length;
    }
  }
  return count;
}

export function checkScope(diffPatch, allowed) {
  const lines = diffPatch.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) {
        const path = m[1];
        if (!allowed.some((glob) => matchGlob(glob, path))) {
          return { pass: false, reason: `scope: path ${path} not in allowed` };
        }
      }
    }
    if (
      line.startsWith("new file mode 120000") ||
      line.startsWith("new file mode 160000")
    ) {
      return { pass: false, reason: "scope: symbolic link or submodule" };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (content.startsWith("<<<<<<< ") || content.startsWith(">>>>>>> ")) {
        return { pass: false, reason: "scope: conflict marker" };
      }
    }
  }
  const modeRe = /^(new|deleted) file mode (120000|160000)$/;
  for (const line of lines) {
    if (modeRe.test(line)) {
      return { pass: false, reason: "scope: symbolic link or submodule mode" };
    }
  }
  const indexRe = /^index [0-9a-f]+\.\.[0-9a-f]+ (120000|160000)$/;
  for (const line of lines) {
    if (indexRe.test(line)) {
      return { pass: false, reason: "scope: symbolic link or submodule index" };
    }
  }
  return { pass: true };
}

function matchGlob(glob, path) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]");
  return new RegExp(`^${escaped}$`).test(path);
}

export function checkFrontend(diffPatch) {
  const lines = diffPatch.split("\n");
  let inFrontendFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) {
        const path = m[1];
        if (path.endsWith(".css")) {
          return { pass: false, reason: "frontend: added CSS file" };
        }
        inFrontendFile =
          path.endsWith(".tsx") ||
          path.endsWith(".jsx") ||
          path.endsWith(".html");
      }
      continue;
    }
    if (!inFrontendFile) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);
    const classAttrRe =
      /(?:className|class)=\{?"([^"{}]*)"|(?:className|class)=[`']([^`'{}]*)[`']/g;
    const cnCallRe = /\bcn\s*\(([^)]*)\)|\bclsx\s*\(([^)]*)\)/g;
    const classTokenSources = [];
    let m;
    while ((m = classAttrRe.exec(content)) !== null) {
      const val = m[1] ?? m[2] ?? "";
      classTokenSources.push(val);
    }
    while ((m = cnCallRe.exec(content)) !== null) {
      const val = m[1] ?? m[2] ?? "";
      classTokenSources.push(val);
    }
    for (const src of classTokenSources) {
      for (const token of src.split(/\s+/)) {
        if (!token) continue;
        const parts = splitVariants(token);
        const utility = parts[parts.length - 1];
        if (utility.includes("[")) {
          return {
            pass: false,
            reason: `frontend: arbitrary value in utility: ${token}`,
          };
        }
      }
    }
  }
  return { pass: true };
}

function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export function computeGate(checksLines, kinds, gateShare) {
  const kindSets = {};
  for (const kind of kinds) {
    kindSets[kind] = { passes: 0, total: 0, breach: null };
  }
  for (const line of checksLines) {
    const k = kindSets[line.kind];
    if (!k) continue;
    k.total++;
    if (line.breach) {
      if (!k.breach) k.breach = line.breach;
    } else if (line.pass) {
      k.passes++;
    }
  }
  const anyBreach = checksLines.some((l) => l.breach != null);
  if (anyBreach) {
    return { verdict: "fail", breach: true };
  }
  const unfinished = checksLines.some((l) => l._planned && !l._done);
  if (unfinished) {
    return { verdict: "no verdict", breach: false };
  }
  for (const kind of kinds) {
    const k = kindSets[kind];
    if (k.total === 0) continue;
    if (k.passes / k.total < gateShare) {
      return { verdict: "fail", breach: false };
    }
  }
  return { verdict: "pass", breach: false };
}

function passShare(passes, total) {
  if (total === 0) return 1;
  return passes / total;
}

export function computeBaseCosl(listPriceUsd, r) {
  if (r === null) return 0;
  return listPriceUsd / r;
}

export function checkStartGate(currentSum, reserve, capUsd) {
  return currentSum + reserve <= capUsd;
}

export function runActionForExit(exitCode, stderrText) {
  if (stderrText && stderrText.includes("cli.run.agent.prompt_text_path")) {
    return "stop";
  }
  if (exitCode === EXIT_OK) return "grade";
  if (exitCode === EXIT_BUDGET_END) return "grade_fail";
  if (exitCode === EXIT_CAP) return "grade_fail";
  if (exitCode === EXIT_PROMPT_PATH) return "stop";
  if (exitCode === EXIT_STOP) return "stop";
  if (exitCode === EXIT_75) return "stop";
  return "stop";
}

export function checkProxyEnv(env) {
  if (env.NODE_USE_ENV_PROXY !== undefined) return true;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  for (const token of nodeOptions.split(/\s+/)) {
    const opt = token.replaceAll('"', "");
    if (opt === "--use-env-proxy" || opt.startsWith("--use-env-proxy=")) {
      return true;
    }
  }
  return false;
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function writeJsonLine(path, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  if (!existsSync(path)) {
    writeFileSync(path, line, { mode: 0o600 });
  } else {
    const existing = readFileSync(path, "utf8");
    writeFileSync(path, existing + line);
  }
}

function gitCmd(cwd, args, env) {
  const result = spawnSync("git", args, {
    cwd,
    env: isolatedGitEnvironment(env ?? process.env),
    encoding: "utf8",
  });
  return result;
}

function gitCmdOrThrow(cwd, args, env) {
  const r = gitCmd(cwd, args, env);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: exit ${r.status}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

function cloneRepo(bundlePath, destDir) {
  gitCmdOrThrow(null, ["clone", "--no-hardlinks", bundlePath, destDir]);
}

function cloneSteps(bundlePath, destDir, commit) {
  cloneRepo(bundlePath, destDir);
  gitCmdOrThrow(destDir, ["checkout", "--detach", commit]);
  gitCmdOrThrow(destDir, ["remote", "remove", "origin"]);
  gitCmdOrThrow(destDir, ["reflog", "expire", "--expire=now", "--all"]);
  const gitConfigCopy = readFileSync(join(destDir, ".git", "config"), "utf8");
  return gitConfigCopy;
}

export function diffArgs() {
  return [
    "diff",
    "--cached",
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ];
}

function runDiffSteps(workspaceDir, commit, savedGitConfig) {
  const gitConfigPath = join(workspaceDir, ".git", "config");
  const gitInfoAttrPath = join(workspaceDir, ".git", "info", "attributes");
  writeFileSync(gitConfigPath, savedGitConfig);
  const attrStat = lstatSync(gitInfoAttrPath, { throwIfNoEntry: false });
  if (attrStat) {
    rmSync(gitInfoAttrPath, { force: true });
  }
  const addResult = gitCmd(workspaceDir, ["add", "-A"]);
  if (addResult.status !== 0) return null;
  const args = [...diffArgs(), commit];
  const diffResult = gitCmd(workspaceDir, args);
  if (diffResult.status !== 0) return null;
  return diffResult.stdout;
}

function copyHiddenTests(checkTestsDir, gradingDir) {
  const entries = readdirSync(checkTestsDir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relPath = join(
      entry.parentPath.slice(checkTestsDir.length + 1),
      entry.name,
    ).replace(/^\//, "");
    const dest = join(gradingDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    const destStat = lstatSync(dest, { throwIfNoEntry: false });
    if (destStat) {
      rmSync(dest, { force: true });
    }
    const src = join(entry.parentPath, entry.name);
    writeFileSync(dest, readFileSync(src));
  }
}

function appendCheckTxt(checkTxt, mode, exitCode, text) {
  const header = `\n--- ${mode} (exit ${exitCode}) ---\n`;
  if (!existsSync(checkTxt)) {
    writeFileSync(checkTxt, header + (text ?? ""), { mode: 0o600 });
  } else {
    const existing = readFileSync(checkTxt, "utf8");
    writeFileSync(checkTxt, existing + header + (text ?? ""));
  }
}

function runCheckMode(checkSh, dir, mode, checkTxt) {
  const r = spawnSync("sh", [checkSh, dir, mode], {
    encoding: "utf8",
    cwd: dir,
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  appendCheckTxt(checkTxt, mode, r.status ?? 1, output);
  return r.status ?? 1;
}

export function gradeCheckRecord(end, a1, a2, a3, a4, breach) {
  if (breach)
    return { a1: false, a2: false, a3: false, a4: false, pass: false, breach };
  const pass = end === END_COMPLETED && a1 && a2 && a3 && a4;
  return { a1, a2, a3, a4, pass, breach: null };
}

function getEngineCommit(engineRoot) {
  const r = gitCmd(engineRoot, ["rev-parse", "HEAD"]);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function isEngineDirty(engineRoot) {
  const r = gitCmd(engineRoot, ["status", "--porcelain"]);
  if (r.status !== 0) return true;
  return r.stdout.trim().length > 0;
}

function getSetCommit(evalSetDir) {
  const r = gitCmd(evalSetDir, ["rev-parse", "HEAD"]);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function readConfig(evalSetDir) {
  const path = join(evalSetDir, "config.json");
  if (!existsSync(path)) return { error: "config.json not found" };
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: "config.json is not valid JSON" };
  }
  return { config: json };
}

function listCaseDir(evalSetDir, set) {
  const casesDir = join(evalSetDir, "cases", set);
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .sort()
    .filter((name) => {
      const st = lstatSync(join(casesDir, name), { throwIfNoEntry: false });
      return st && st.isDirectory();
    });
}

function readCaseJson(caseDir) {
  const path = join(caseDir, "case.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function findEarlierHeldOutEvals(resultsBaseDir, stage) {
  if (!existsSync(resultsBaseDir)) return [];
  return readdirSync(resultsBaseDir)
    .filter((name) => {
      const iterPath = join(resultsBaseDir, name, "iteration.json");
      if (!existsSync(iterPath)) return false;
      try {
        const iter = JSON.parse(readFileSync(iterPath, "utf8"));
        return iter.set === "held-out" && iter.stage === stage;
      } catch {
        return false;
      }
    })
    .sort();
}

async function runEvaluation(argv) {
  if (checkProxyEnv(process.env)) {
    process.stderr.write(
      "evaluation: NODE_USE_ENV_PROXY or --use-env-proxy is set\n",
    );
    process.exit(EXIT_STOP);
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      evaluation: { type: "string" },
      stage: { type: "string" },
      set: { type: "string" },
    },
    strict: true,
  });

  const { evaluation: evalId, stage: stageStr, set: setStr } = values;

  if (!evalId || !EVAL_ID_RE.test(evalId)) {
    process.stderr.write(
      "evaluation: --evaluation is required and must contain only letters, digits, - and _\n",
    );
    process.exit(EXIT_STOP);
  }
  if (stageStr !== "1" && stageStr !== "2") {
    process.stderr.write("evaluation: --stage must be 1 or 2\n");
    process.exit(EXIT_STOP);
  }
  if (setStr !== "dev" && setStr !== "held-out") {
    process.stderr.write("evaluation: --set must be dev or held-out\n");
    process.exit(EXIT_STOP);
  }
  if (setStr === "dev") {
    process.stderr.write("evaluation: --set dev is not yet supported\n");
    process.exit(EXIT_STOP);
  }

  const stage = Number(stageStr);

  if (isEngineDirty(ENGINE_ROOT)) {
    process.stderr.write("evaluation: engine tree is dirty\n");
    process.exit(EXIT_STOP);
  }

  const engineCommit = getEngineCommit(ENGINE_ROOT);
  if (!engineCommit) {
    process.stderr.write("evaluation: could not read engine commit\n");
    process.exit(EXIT_STOP);
  }

  const env = process.env;
  const dirs = directories(env);
  const evalSetDir = join(dirs.data, "evaluation", "agent");
  const resultsBaseDir = join(dirs.state, "evaluation", "runs");

  if (!existsSync(evalSetDir)) {
    process.stderr.write(
      `evaluation: evaluation set not found: ${evalSetDir}\n`,
    );
    process.exit(EXIT_STOP);
  }

  const { config: rawConfig, error: configError } = readConfig(evalSetDir);
  if (configError) {
    process.stderr.write(`evaluation: ${configError}\n`);
    process.exit(EXIT_STOP);
  }

  const configErr = validateConfig(rawConfig);
  if (configErr) {
    process.stderr.write(
      `evaluation: config.json: ${configErr.message} (key: ${configErr.key})\n`,
    );
    process.exit(EXIT_STOP);
  }

  const priceResult = await readModelPrices();
  const baseModelCost = getModelCost(priceResult, rawConfig.base_model);
  if (!baseModelCost) {
    process.stderr.write(
      `evaluation: config.json base_model: pi gives no model for ${rawConfig.base_model}\n`,
    );
    process.exit(EXIT_STOP);
  }
  const basePrices = highestTierCost(baseModelCost);
  if (!basePrices.input && !basePrices.output && !basePrices.cacheRead) {
    process.stderr.write(`evaluation: config.json base_model has no price\n`);
    process.exit(EXIT_STOP);
  }
  const base100 = blend100(baseModelCost);

  const runModelCost = getModelCost(priceResult, rawConfig.model);
  const run100 = runModelCost ? blend100(runModelCost) : null;
  const runR = run100 !== null ? run100 / base100 : null;

  const setCommit = getSetCommit(evalSetDir);
  if (!setCommit) {
    process.stderr.write("evaluation: could not read evaluation set commit\n");
    process.exit(EXIT_STOP);
  }

  const resultsDir = join(resultsBaseDir, evalId);
  mkdirSync(resultsDir, { recursive: true, mode: EVAL_DIR_MODE });
  const iterPath = join(resultsDir, "iteration.json");
  const callsPath = join(resultsDir, "calls.jsonl");

  let iterationJson;
  if (existsSync(iterPath)) {
    iterationJson = JSON.parse(readFileSync(iterPath, "utf8"));
    if (iterationJson.evaluation_id !== evalId) {
      process.stderr.write(
        "evaluation: iteration.json mismatch: evaluation_id\n",
      );
      process.exit(EXIT_STOP);
    }
    if (iterationJson.stage !== stage) {
      process.stderr.write("evaluation: iteration.json mismatch: stage\n");
      process.exit(EXIT_STOP);
    }
    if (iterationJson.set !== setStr) {
      process.stderr.write("evaluation: iteration.json mismatch: set\n");
      process.exit(EXIT_STOP);
    }
    if (iterationJson.set_commit !== setCommit) {
      process.stderr.write(
        `evaluation: set_commit does not match evaluation set HEAD (${setCommit})\n`,
      );
      process.exit(EXIT_STOP);
    }
  } else {
    if (setStr === "held-out") {
      const earlier = findEarlierHeldOutEvals(resultsBaseDir, stage);
      if (earlier.length > 0) {
        const earlierPath = join(resultsBaseDir, earlier[0], "iteration.json");
        const earlierIter = JSON.parse(readFileSync(earlierPath, "utf8"));
        if (earlierIter.gate_share !== rawConfig.gate_share) {
          process.stderr.write(
            `evaluation: config.json gate_share ${rawConfig.gate_share} differs from earlier held-out evaluation ${earlier[0]}\n`,
          );
          process.exit(EXIT_STOP);
        }
      }
    }
    iterationJson = {
      evaluation_id: evalId,
      stage,
      set: setStr,
      set_commit: setCommit,
      engine_commit: engineCommit,
      repeats: rawConfig.repeats,
      gate_share: setStr === "held-out" ? rawConfig.gate_share : null,
      parent: null,
      replicate: null,
      aspect: null,
      hypothesis: null,
    };
    writeFileSync(iterPath, `${JSON.stringify(iterationJson)}\n`, {
      mode: 0o600,
    });
  }

  writeJsonLine(callsPath, { cap_usd: rawConfig.cap_usd });

  const casesDir = join(evalSetDir, "cases", setStr);
  const caseIds = listCaseDir(evalSetDir, setStr);
  if (caseIds.length === 0) {
    process.stderr.write(`evaluation: no cases found in ${casesDir}\n`);
    process.exit(EXIT_STOP);
  }

  const checksPath = join(resultsDir, "checks.jsonl");
  const resultsJsonlPath = join(resultsDir, "results.jsonl");

  const doneKeys = new Set();
  for (const checkLine of readJsonLines(checksPath)) {
    doneKeys.add(`${checkLine.case}:${checkLine.repeat}`);
  }

  const authPath = join(userInfo().homedir, ".config", "kanthord", "auth.json");
  const credValues = extractCredentialValues(authPath);
  const authSaved = captureAuthState(authPath);
  if (!authSaved) {
    process.stderr.write("evaluation: auth.json not found or not a file\n");
    process.exit(EXIT_STOP);
  }

  let baseCostSum = 0;
  for (const line of readJsonLines(resultsJsonlPath)) {
    if (line.list_price_usd && runR !== null) {
      baseCostSum += computeBaseCosl(line.list_price_usd, runR);
    }
  }

  const workBaseDir = join(dirs.state, "evaluation", "work");
  mkdirSync(workBaseDir, { recursive: true, mode: EVAL_DIR_MODE });

  let stopped = false;
  let stopReason = null;

  outer: for (const caseId of caseIds) {
    const caseFolder = join(casesDir, caseId);
    const caseJson = readCaseJson(caseFolder);
    if (!caseJson) {
      process.stderr.write(`evaluation: could not read ${caseId}/case.json\n`);
      stopped = true;
      stopReason = "case read error";
      break;
    }
    const caseErr = validateCase(caseJson);
    if (caseErr) {
      process.stderr.write(`evaluation: case ${caseId}: ${caseErr}\n`);
      stopped = true;
      stopReason = "case schema error";
      break;
    }

    const wallMs = parseDuration(caseJson.wall);
    const usdCents = parseUsdCents(caseJson.usd);

    for (let repeat = 1; repeat <= iterationJson.repeats; repeat++) {
      const key = `${caseId}:${repeat}`;
      if (doneKeys.has(key)) continue;

      let reserve = 0;
      if (usdCents !== null) {
        if (runR !== null) {
          reserve = scaleUsdCents(usdCents, run100, base100) / CENTS_PER_DOLLAR;
        }
      }

      if (!checkStartGate(baseCostSum, reserve, rawConfig.cap_usd)) {
        stopped = true;
        stopReason = "cap";
        break outer;
      }

      const runDirName = `${caseId}/${repeat}-1`;
      const runDir = join(resultsDir, runDirName);
      mkdirSync(runDir, { recursive: true, mode: EVAL_DIR_MODE });

      const workRoot = join(workBaseDir, randomName());
      mkdirSync(workRoot, { mode: EVAL_DIR_MODE });

      let savedGitConfig;
      try {
        savedGitConfig = cloneSteps(
          join(caseFolder, "repo.bundle"),
          join(workRoot, "w"),
          caseJson.commit,
        );
      } catch (err) {
        process.stderr.write(
          `evaluation: clone failed for ${caseId}: ${err.message}\n`,
        );
        rmSync(workRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = "clone error";
        break outer;
      }

      const setupResult = spawnSync("sh", [join(caseFolder, "setup.sh")], {
        cwd: join(workRoot, "w"),
        encoding: "utf8",
      });
      if (setupResult.status !== 0) {
        process.stderr.write(`evaluation: setup.sh failed for ${caseId}\n`);
        rmSync(workRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = "setup.sh failed";
        break outer;
      }

      const runModel = rawConfig.model;
      const runProvider = parseModelString(runModel)?.provider;

      try {
        await refreshAuth(authPath, runProvider, wallMs + REFRESH_MARGIN_MS);
      } catch {
        process.stderr.write("evaluation: credential refresh failed\n");
        rmSync(workRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = "refresh failed";
        break outer;
      }

      const authStateAfterRefresh = captureAuthState(authPath);
      if (!authStateAfterRefresh || checkAuthFileBreach(authPath, authSaved)) {
        process.stderr.write("evaluation: auth.json changed during refresh\n");
        rmSync(workRoot, { recursive: true, force: true });
        writeCheckBreachLine(
          checksPath,
          resultsJsonlPath,
          caseId,
          repeat,
          BREACH_AUTH_FILE,
        );
        stopped = true;
        stopReason = BREACH_AUTH_FILE;
        break outer;
      }

      const sessionPath = join(runDir, "session.jsonl");
      const stderrPath = join(runDir, "stderr.txt");

      const runArgs = buildRunAgentArgs(
        runModel,
        caseJson,
        stage,
        evalSetDir,
        workRoot,
        sessionPath,
        resultsJsonlPath,
        join(caseFolder, "task.md"),
        usdCents,
        wallMs,
        run100,
        base100,
      );

      const runResult = spawnSync(process.execPath, [BIN, ...runArgs], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });

      const stderrText = runResult.stderr ?? "";
      writeFileSync(stderrPath, stderrText, { mode: 0o600 });

      if (checkAuthFileBreach(authPath, authStateAfterRefresh)) {
        const countInSession = existsSync(sessionPath)
          ? countCredentialInText(readFileSync(sessionPath, "utf8"), credValues)
          : 0;
        process.stdout.write(`${countInSession}\n`);
        rmSync(workRoot, { recursive: true, force: true });
        writeCheckBreachLine(
          checksPath,
          resultsJsonlPath,
          caseId,
          repeat,
          BREACH_AUTH_FILE,
        );
        stopped = true;
        stopReason = BREACH_AUTH_FILE;
        break outer;
      }

      const sessionText = existsSync(sessionPath)
        ? readFileSync(sessionPath, "utf8")
        : "";
      const countInSession = countCredentialInText(sessionText, credValues);
      if (countInSession > 0) {
        process.stdout.write(`${countInSession}\n`);
        rmSync(workRoot, { recursive: true, force: true });
        writeCheckBreachLine(
          checksPath,
          resultsJsonlPath,
          caseId,
          repeat,
          BREACH_CREDENTIAL,
        );
        stopped = true;
        stopReason = BREACH_CREDENTIAL;
        break outer;
      }

      const exitCode = runResult.status ?? 1;
      const action = runActionForExit(exitCode, stderrText);

      if (action === "stop") {
        rmSync(workRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = `run exit ${exitCode}`;
        break outer;
      }

      const diffPatchStr = runDiffSteps(
        join(workRoot, "w"),
        caseJson.commit,
        savedGitConfig,
      );
      if (diffPatchStr !== null) {
        writeFileSync(join(runDir, "diff.patch"), diffPatchStr, {
          mode: 0o600,
        });
      }

      const countInDiff =
        diffPatchStr !== null
          ? countCredentialInText(diffPatchStr, credValues)
          : 0;
      if (countInDiff > 0) {
        process.stdout.write(`${countInDiff}\n`);
        const dp = join(runDir, "diff.patch");
        if (existsSync(dp)) rmSync(dp);
        rmSync(workRoot, { recursive: true, force: true });
        writeCheckBreachLine(
          checksPath,
          resultsJsonlPath,
          caseId,
          repeat,
          BREACH_CREDENTIAL,
        );
        stopped = true;
        stopReason = BREACH_CREDENTIAL;
        break outer;
      }

      const gradingRoot = join(workBaseDir, randomName());
      mkdirSync(gradingRoot, { mode: EVAL_DIR_MODE });
      try {
        cloneSteps(
          join(caseFolder, "repo.bundle"),
          join(gradingRoot, "g"),
          caseJson.commit,
        );
      } catch {
        rmSync(workRoot, { recursive: true, force: true });
        rmSync(gradingRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = "grading clone error";
        break outer;
      }

      const gradingSetupResult = spawnSync(
        "sh",
        [join(caseFolder, "setup.sh")],
        {
          cwd: join(gradingRoot, "g"),
          encoding: "utf8",
        },
      );
      if (gradingSetupResult.status !== 0) {
        rmSync(workRoot, { recursive: true, force: true });
        rmSync(gradingRoot, { recursive: true, force: true });
        stopped = true;
        stopReason = "grading setup.sh failed";
        break outer;
      }

      if (diffPatchStr !== null && diffPatchStr.length > 0) {
        const applyResult = gitCmd(join(gradingRoot, "g"), [
          "apply",
          "--binary",
          join(runDir, "diff.patch"),
        ]);
        if (applyResult.status !== 0) {
          appendCheckTxt(
            join(runDir, "check.txt"),
            "apply",
            1,
            applyResult.stderr,
          );
        } else {
          runCheckMode(
            join(caseFolder, "check", "check.sh"),
            join(gradingRoot, "g"),
            "conventions",
            join(runDir, "check.txt"),
          );
          const checkTestsDir1 = join(caseFolder, "check", "tests");
          if (existsSync(checkTestsDir1)) {
            copyHiddenTests(checkTestsDir1, join(gradingRoot, "g"));
          }
          runCheckMode(
            join(caseFolder, "check", "check.sh"),
            join(gradingRoot, "g"),
            "fail_to_pass",
            join(runDir, "check.txt"),
          );
          runCheckMode(
            join(caseFolder, "check", "check.sh"),
            join(gradingRoot, "g"),
            "pass_to_pass",
            join(runDir, "check.txt"),
          );
        }
      } else {
        runCheckMode(
          join(caseFolder, "check", "check.sh"),
          join(gradingRoot, "g"),
          "conventions",
          join(runDir, "check.txt"),
        );
        const checkTestsDir2 = join(caseFolder, "check", "tests");
        if (existsSync(checkTestsDir2)) {
          copyHiddenTests(checkTestsDir2, join(gradingRoot, "g"));
        }
        runCheckMode(
          join(caseFolder, "check", "check.sh"),
          join(gradingRoot, "g"),
          "fail_to_pass",
          join(runDir, "check.txt"),
        );
        runCheckMode(
          join(caseFolder, "check", "check.sh"),
          join(gradingRoot, "g"),
          "pass_to_pass",
          join(runDir, "check.txt"),
        );
      }

      const checkTxtPath = join(runDir, "check.txt");
      const checkTxtContent = existsSync(checkTxtPath)
        ? readFileSync(checkTxtPath, "utf8")
        : "";
      const countInCheck = countCredentialInText(checkTxtContent, credValues);
      if (countInCheck > 0) {
        process.stdout.write(`${countInCheck}\n`);
        if (existsSync(join(runDir, "diff.patch")))
          rmSync(join(runDir, "diff.patch"));
        if (existsSync(checkTxtPath)) rmSync(checkTxtPath);
        rmSync(workRoot, { recursive: true, force: true });
        rmSync(gradingRoot, { recursive: true, force: true });
        writeCheckBreachLine(
          checksPath,
          resultsJsonlPath,
          caseId,
          repeat,
          BREACH_CREDENTIAL,
        );
        stopped = true;
        stopReason = BREACH_CREDENTIAL;
        break outer;
      }

      const checkRecord = computeCheckRecord(
        runDir,
        resultsJsonlPath,
        caseId,
        repeat,
        caseJson,
        diffPatchStr,
      );

      writeJsonLine(checksPath, checkRecord);
      doneKeys.add(key);

      if (setStr === "held-out") {
        if (existsSync(checkTxtPath)) rmSync(checkTxtPath);
      }
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(gradingRoot, { recursive: true, force: true });

      const resultLine = readJsonLines(resultsJsonlPath).find(
        (l) => l.session === sessionPath,
      );
      if (resultLine && resultLine.list_price_usd && runR !== null) {
        baseCostSum += computeBaseCosl(resultLine.list_price_usd, runR);
      }
    }
  }

  if (stopped && stopReason === "cap") {
    writeReport(
      resultsDir,
      iterationJson,
      rawConfig,
      run100,
      base100,
      runR,
      caseIds,
    );
    process.exit(EXIT_CAP);
  }

  if (stopped) {
    writeReport(
      resultsDir,
      iterationJson,
      rawConfig,
      run100,
      base100,
      runR,
      caseIds,
    );
    process.exit(EXIT_STOP);
  }

  writeReport(
    resultsDir,
    iterationJson,
    rawConfig,
    run100,
    base100,
    runR,
    caseIds,
  );
  process.exit(EXIT_OK);
}

function buildRunAgentArgs(
  model,
  caseJson,
  stage,
  evalSetDir,
  workRoot,
  sessionPath,
  resultsJsonlPath,
  promptPath,
  usdCents,
  wallMs,
  run100,
  base100,
) {
  const args = ["run", "agent", PROFILE_SWE];
  args.push("--model", model);
  args.push("--budget", caseJson.wall);
  if (usdCents !== null && run100 !== null) {
    const scaledCents = scaleUsdCents(usdCents, run100, base100);
    const scaledUsd = (scaledCents / CENTS_PER_DOLLAR).toFixed(2);
    args.push("--budget", `${scaledUsd}${USD_SUFFIX}`);
  }
  if (stage === 2) {
    const kind = caseJson.kind;
    args.push("--system-prompt", join(evalSetDir, "binding", `${kind}.md`));
  }
  args.push("--workspace", join(workRoot, "w"));
  args.push("--session", sessionPath);
  args.push("--output", resultsJsonlPath);
  args.push("--prompt", promptPath);
  return args;
}

function writeCheckBreachLine(
  checksPath,
  resultsJsonlPath,
  caseId,
  repeat,
  breach,
) {
  const sessionPath = "";
  writeJsonLine(checksPath, {
    case: caseId,
    repeat,
    session: sessionPath,
    a1: false,
    a2: false,
    a3: false,
    a4: false,
    pass: false,
    breach,
  });
}

function computeCheckRecord(
  runDir,
  resultsJsonlPath,
  caseId,
  repeat,
  caseJson,
  diffPatchStr,
) {
  const sessionPath = join(runDir, "session.jsonl");
  const checkTxtPath = join(runDir, "check.txt");

  const resultLine = readJsonLines(resultsJsonlPath)
    .reverse()
    .find((l) => l.session === sessionPath);
  const end = resultLine?.end ?? "failed";

  const a3Result = checkScope(diffPatchStr ?? "", caseJson.allowed);
  const a3 = a3Result.pass;

  if (!existsSync(checkTxtPath)) {
    return gradeCheckRecord(end, false, false, a3, false, null);
  }

  const checkTxt = readFileSync(checkTxtPath, "utf8");
  const a1 = checkTxtContains(checkTxt, "fail_to_pass", 0);
  const a2 = checkTxtContains(checkTxt, "pass_to_pass", 0);
  const a4 = checkTxtContains(checkTxt, "conventions", 0);

  return {
    ...gradeCheckRecord(end, a1, a2, a3, a4, null),
    case: caseId,
    repeat,
    session: sessionPath,
  };
}

function checkTxtContains(checkTxt, mode, expectedExit) {
  const re = new RegExp(`--- ${mode} \\(exit (\\d+)\\) ---`);
  const m = re.exec(checkTxt);
  if (!m) return false;
  return Number(m[1]) === expectedExit;
}

function writeReport(
  resultsDir,
  iterationJson,
  config,
  run100,
  base100,
  runR,
  caseIds,
) {
  const checksPath = join(resultsDir, "checks.jsonl");
  const resultsJsonlPath = join(resultsDir, "results.jsonl");
  const callsPath = join(resultsDir, "calls.jsonl");

  const checksLines = readJsonLines(checksPath);
  const resultLines = readJsonLines(resultsJsonlPath);
  const callsLines = readJsonLines(callsPath);

  const swe1Lines = resultLines.filter((l) => l.agent === PROFILE_SWE);
  const capLine =
    callsLines.length > 0 ? callsLines[callsLines.length - 1] : null;

  const setStr = iterationJson.set;
  const stage = iterationJson.stage;
  const setCommit = iterationJson.set_commit;
  const evalId = iterationJson.evaluation_id;
  const gateShare = iterationJson.gate_share;

  const lines = [];
  lines.push(`# Evaluation: ${evalId}`);
  lines.push(`stage: ${stage}`);
  lines.push(`set: ${setStr}`);
  lines.push(`set commit: ${setCommit}`);
  lines.push("");

  const totalPlanned = caseIds.length * iterationJson.repeats;
  const totalDone = checksLines.length;
  const breachLines = checksLines.filter((l) => l.breach);
  const passLines = checksLines.filter((l) => l.pass && !l.breach);

  if (setStr === "held-out") {
    lines.push("## Goal table");
    lines.push(`A1 good: ${checksLines.filter((l) => l.a1).length}`);
    lines.push(`A2 good: ${checksLines.filter((l) => l.a2).length}`);
    lines.push(`A3 good: ${checksLines.filter((l) => l.a3).length}`);
    lines.push(`A4 good: ${checksLines.filter((l) => l.a4).length}`);
    lines.push(
      `A9 breaches: ${breachLines.length}${breachLines.length > 0 ? ` (${[...new Set(breachLines.map((l) => l.breach))].join(", ")})` : ""}`,
    );
    lines.push(`passed: ${passLines.length} of ${totalDone}`);
    lines.push("");

    lines.push("## Gate");
    const passShareVal = passShare(passLines.length, totalDone);
    const passSharePct = `${(passShareVal * 100).toFixed(1)}%`;

    const hasNoVerdictRuns =
      totalDone < totalPlanned && breachLines.length === 0;
    let gateVerdict;
    if (breachLines.length > 0) {
      gateVerdict = "fail";
    } else if (hasNoVerdictRuns) {
      gateVerdict = "no verdict";
    } else {
      gateVerdict = passShareVal >= gateShare ? "pass" : "fail";
    }

    lines.push(`pass share: ${passSharePct}`);
    lines.push(`gate_share: ${gateShare}`);
    lines.push(`breaches: ${breachLines.length}`);
    lines.push(`earlier held-out evaluations: 0`);
    lines.push(`verdict: ${gateVerdict}`);
    lines.push("");
  }

  lines.push("## Cost");
  let listPriceSum = 0;
  let baseCostSum2 = 0;
  for (const l of swe1Lines) {
    listPriceSum += l.list_price_usd ?? 0;
    if (runR !== null)
      baseCostSum2 += computeBaseCosl(l.list_price_usd ?? 0, runR);
  }
  const rStr = runR !== null ? runR.toFixed(4) : "none";
  lines.push(
    `swe@1: list price ${listPriceSum.toFixed(6)} usd, r ${rStr}, base cost ${baseCostSum2.toFixed(6)}`,
  );
  lines.push(`cap: ${capLine?.cap_usd ?? config.cap_usd}`);
  const unstarted = totalPlanned - totalDone;
  lines.push(`unstarted runs: ${unstarted}`);
  lines.push(`unstarted diagnoses: 0`);
  lines.push("");

  const reportPath = join(resultsDir, "report.md");
  writeFileSync(reportPath, lines.join("\n") + "\n", { mode: 0o600 });
}

const caseKindMap = {};

async function runReport(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      evaluation: { type: "string" },
    },
    strict: true,
  });

  const { evaluation: evalId } = values;
  if (!evalId) {
    process.stderr.write("evaluation: --evaluation is required\n");
    process.exit(EXIT_STOP);
  }

  const env = process.env;
  const dirs = directories(env);
  const resultsDir = join(dirs.state, "evaluation", "runs", evalId);
  const iterPath = join(resultsDir, "iteration.json");

  if (!existsSync(iterPath)) {
    process.stderr.write(
      `evaluation: iteration.json not found in ${resultsDir}\n`,
    );
    process.exit(EXIT_STOP);
  }

  const iterationJson = JSON.parse(readFileSync(iterPath, "utf8"));
  const evalSetDir = join(dirs.data, "evaluation", "agent");
  const { config: rawConfig, error: configError } = readConfig(evalSetDir);
  if (configError) {
    process.stderr.write(`evaluation: ${configError}\n`);
    process.exit(EXIT_STOP);
  }
  const configErr = validateConfig(rawConfig);
  if (configErr) {
    process.stderr.write(`evaluation: config.json: ${configErr.message}\n`);
    process.exit(EXIT_STOP);
  }

  const priceResult = await readModelPrices();
  const baseModelCost = getModelCost(priceResult, rawConfig.base_model);
  if (!baseModelCost) {
    process.stderr.write(
      `evaluation: config.json base_model: pi gives no model\n`,
    );
    process.exit(EXIT_STOP);
  }
  const base100 = blend100(baseModelCost);
  const runModelCost = getModelCost(priceResult, rawConfig.model);
  const run100 = runModelCost ? blend100(runModelCost) : null;
  const runR = run100 !== null ? run100 / base100 : null;

  const resultsJsonlPath = join(resultsDir, "results.jsonl");

  const resultLines = readJsonLines(resultsJsonlPath);

  const swe1Lines = resultLines.filter((l) => l.agent === PROFILE_SWE);

  const keyErr = checkResultKeys(swe1Lines);
  if (keyErr) {
    process.stderr.write(`evaluation: ${keyErr}\n`);
    process.exit(EXIT_STOP);
  }

  const setStr = iterationJson.set;
  const casesDir = join(evalSetDir, "cases", setStr);
  const caseIds = listCaseDir(evalSetDir, setStr);

  for (const caseId of caseIds) {
    const caseFolder = join(casesDir, caseId);
    const caseJson = readCaseJson(caseFolder);
    if (caseJson) caseKindMap[caseId] = caseJson.kind;
  }

  writeReport(
    resultsDir,
    iterationJson,
    rawConfig,
    run100,
    base100,
    runR,
    caseIds,
  );

  const reportPath = join(resultsDir, "report.md");
  const reportText = readFileSync(reportPath, "utf8");

  const hasNoVerdict = reportText.includes("verdict: no verdict");
  if (hasNoVerdict) {
    process.exit(3);
  }
  process.exit(EXIT_OK);
}

export function checkResultKeys(swe1Lines) {
  if (swe1Lines.length === 0) return null;
  const engineVersions = new Set(swe1Lines.map((l) => l.engine_version));
  if (engineVersions.size > 1)
    return "swe@1 lines have more than one engine_version";
  const providers = new Set(swe1Lines.map((l) => l.provider));
  if (providers.size > 1) return "swe@1 lines have more than one provider";
  const models = new Set(swe1Lines.map((l) => l.model));
  if (models.size > 1) return "swe@1 lines have more than one model";
  const efforts = new Set(swe1Lines.map((l) => l.reasoning_effort));
  if (efforts.size > 1)
    return "swe@1 lines have more than one reasoning_effort";
  const digests = new Set(swe1Lines.map((l) => l.system_prompt_digest));
  if (digests.size > 1)
    return "swe@1 lines have more than one system_prompt_digest";

  const caseLines = {};
  for (const line of swe1Lines) {
    const caseId = line.case;
    if (caseId) {
      if (!caseLines[caseId]) caseLines[caseId] = [];
      caseLines[caseId].push(line);
    }
  }
  for (const [caseId, lines] of Object.entries(caseLines)) {
    const inputDigests = new Set(lines.map((l) => l.input_digest));
    if (inputDigests.size > 1)
      return `case ${caseId}: swe@1 lines have more than one input_digest`;
    const budgets = new Set(lines.map((l) => JSON.stringify(l.budget)));
    if (budgets.size > 1)
      return `case ${caseId}: swe@1 lines have more than one budget`;
  }
  return null;
}

const IS_MAIN =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (IS_MAIN) {
  const subcommand = process.argv[2];
  if (subcommand === "run") {
    await runEvaluation(process.argv.slice(3));
  } else if (subcommand === "report") {
    await runReport(process.argv.slice(3));
  } else {
    process.stderr.write(
      `evaluation: unknown subcommand: ${subcommand ?? "(none)"}\n`,
    );
    process.exit(EXIT_STOP);
  }
}
