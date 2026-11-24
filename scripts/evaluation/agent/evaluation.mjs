import { createHash, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { isolatedGitEnvironment } from "../../../dist/kernel/git-environment.js";
import { directories } from "../../../dist/kernel/xdg.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ENGINE_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const BIN = join(ENGINE_ROOT, "bin", "kanthord.mjs");

const OAUTH_TYPE = "oauth";
const API_KEY_TYPE = "api_key";
const REFRESH_MARGIN_MS = 10 * 60000;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 16;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const BLEND_INPUT_WEIGHT = 20;
const BLEND_CACHE_READ_WEIGHT = 80;
const BLEND_OUTPUT_WEIGHT = 2;
const CENTS_PER_DOLLAR = 100;
const MICRO_SCALE = 1000000;
const MAX_WALL_MS = 7200000;
const WALL_UNITS = { s: 1000, m: 60000, h: 3600000 };
const USD_SUFFIX = "usd";
const USD_FRACTION_DIGITS = 2;
const CHECK_OUTPUT_LIMIT = 64 * 1024 * 1024;
const BREACH_CREDENTIAL = "credential";
const BREACH_AUTH_FILE = "auth_file";
const PROFILE_SWE = "swe@1";
const PROFILE_RE = "re@1";
const SET_DEV = "dev";
const SET_HELD_OUT = "held-out";
const SET_VALUES = [SET_DEV, SET_HELD_OUT];
const STAGE_VALUES = ["1", "2"];
const BINDING_STAGE = 2;
const KIND_FRONTEND = "frontend";
const KIND_VALUES = ["backend", KIND_FRONTEND];
const END_COMPLETED = "completed";
const END_ABSENT = "failed";
const EVAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const HEX_COMMIT_RE = /^[0-9a-f]{40}$/;
const EXIT_OK = 0;
const EXIT_STOP = 1;
const EXIT_NO_VERDICT = 3;
const EXIT_CAP = 4;
const GRADED_RUN_EXITS = [0, 4, 5];
const PROMPT_TEXT_PATH_CODE = "cli.run.agent.prompt_text_path";
const ACTION_GRADE = "grade";
const ACTION_STOP = "stop";
const VERDICT_PASS = "pass";
const VERDICT_FAIL = "fail";
const VERDICT_NONE = "no verdict";
const STOP_BREACH = "breach";
const STOP_CAP = "cap";
const NONE_TEXT = "none";
const WORKSPACE_NAME = "w";
const GRADING_NAME = "g";
const JUDGE_DIR = "j";
const JUDGE_WALL = "15m";
const DIAGNOSES_FILE = "diagnoses.jsonl";
const VERDICT_COMPLETE = "complete";
const DIAGNOSIS_ASPECTS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
];
const DIAGNOSIS_SEVERITIES = ["high", "medium", "low"];
const MAX_FINDINGS = 20;
const EVIDENCE_MAX = 500;
const TRANSCRIPT_TOOL_RESULT_LIMIT = 4000;
const TRANSCRIPT_ENTRY_TYPE = "message";
const MODE_CONVENTIONS = "conventions";
const MODE_FAIL_TO_PASS = "fail_to_pass";
const MODE_PASS_TO_PASS = "pass_to_pass";
const MODE_APPLY = "apply";
const DIFF_HEADER = "diff --git ";
const DIFF_HEADER_OVERHEAD = "a/ b/".length;
const NEW_FILE_PREFIX = "new file mode ";
const LINK_MODE_RE =
  /^(?:(?:new file|deleted file|old|new) mode|index [0-9a-f]+\.\.[0-9a-f]+) (?:120000|160000)$/;
const CONFLICT_MARKERS = ["<<<<<<< ", ">>>>>>> "];
const FRONTEND_EXTENSIONS = [".tsx", ".jsx", ".html"];
const CSS_EXTENSION = ".css";
const CLASS_ATTRIBUTE_RE =
  /(?:className|class)=\{?"([^"{}]*)"|(?:className|class)=\{?'([^'{}]*)'/g;
const CLASS_HELPER_RE = /\b(?:cn|clsx)\s*\(/g;
const QUOTES = ['"', "'", "`"];
const TEMPLATE_EXPRESSION = "${";
const RESULT_KEYS = [
  "provider",
  "model",
  "reasoning_effort",
  "system_prompt_digest",
];
const CASE_KEYS = ["input_digest", "budget"];
const CASE_REQUIRED = ["kind", "commit", "wall", "usd", "allowed"];
const CONFIG_REQUIRED = [
  "cap_usd",
  "base_model",
  "model",
  "judge_model",
  "judge_usd",
  "repeats",
  "gate_share",
];
const BASE_PRICE_KEYS = ["input", "output", "cacheRead"];
const MIN_REPEATS = 2;

function randomName() {
  let name = "";
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    name += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return name;
}

function parseWallMs(value) {
  if (typeof value !== "string") return null;
  const m = /^([1-9][0-9]*)(s|m|h)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * WALL_UNITS[m[2]];
}

export function parseUsdCents(value) {
  if (typeof value !== "string") return null;
  const m = /^([0-9]+)(?:\.([0-9]{1,2}))?usd$/.exec(value);
  if (!m) return null;
  const fraction = (m[2] ?? "").padEnd(USD_FRACTION_DIGITS, "0");
  const cents = Number(m[1]) * CENTS_PER_DOLLAR + Number(fraction);
  return cents > 0 ? cents : null;
}

function parseBaseModel(value) {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function parseModelSelection(value) {
  if (typeof value !== "string") return null;
  const colon = value.lastIndexOf(":");
  if (colon === -1 || colon === value.length - 1) return null;
  if (colon < value.indexOf("/")) return null;
  return parseBaseModel(value.slice(0, colon));
}

function isObject(json) {
  return json !== null && typeof json === "object" && !Array.isArray(json);
}

function keyError(json, required) {
  for (const key of required) {
    if (!(key in json)) return key;
  }
  return Object.keys(json).find((key) => !required.includes(key)) ?? null;
}

function caseValueError(json) {
  if (!KIND_VALUES.includes(json.kind)) return "kind";
  if (typeof json.commit !== "string" || !HEX_COMMIT_RE.test(json.commit))
    return "commit";
  const wallMs = parseWallMs(json.wall);
  if (wallMs === null || wallMs > MAX_WALL_MS) return "wall";
  if (parseUsdCents(json.usd) === null) return "usd";
  if (!Array.isArray(json.allowed) || json.allowed.length === 0)
    return "allowed";
  const globs = json.allowed.every(
    (glob) => typeof glob === "string" && glob.length > 0,
  );
  return globs ? null : "allowed";
}

export function validateCase(json) {
  if (!isObject(json)) return "case.json is no JSON object";
  const key = keyError(json, CASE_REQUIRED) ?? caseValueError(json);
  if (key === null) return null;
  return `case.json: key ${key}`;
}

function configValueError(json) {
  if (typeof json.cap_usd !== "number" || !(json.cap_usd > 0)) return "cap_usd";
  if (parseBaseModel(json.base_model) === null) return "base_model";
  if (parseModelSelection(json.model) === null) return "model";
  if (parseModelSelection(json.judge_model) === null) return "judge_model";
  if (parseUsdCents(json.judge_usd) === null) return "judge_usd";
  if (!Number.isInteger(json.repeats) || json.repeats < MIN_REPEATS)
    return "repeats";
  const share = json.gate_share;
  if (typeof share !== "number" || !(share > 0) || share > 1)
    return "gate_share";
  return null;
}

export function validateConfig(json) {
  if (!isObject(json))
    return { key: null, message: "the file is no JSON object" };
  const key = keyError(json, CONFIG_REQUIRED) ?? configValueError(json);
  if (key === null) return null;
  return { key, message: `key ${key}` };
}

export function highestTierCost(cost) {
  if (!cost.tiers || cost.tiers.length === 0) return cost;
  return cost.tiers.reduce((a, b) =>
    b.inputTokensAbove > a.inputTokensAbove ? b : a,
  );
}

export function blend100(cost) {
  const c = highestTierCost(cost);
  return (
    BLEND_CACHE_READ_WEIGHT * Math.round(c.cacheRead * MICRO_SCALE) +
    BLEND_INPUT_WEIGHT * Math.round(c.input * MICRO_SCALE) +
    BLEND_OUTPUT_WEIGHT * Math.round(c.output * MICRO_SCALE)
  );
}

export function scaleUsdCents(usdCents, modelBlend, baseBlend) {
  const numerator = BigInt(usdCents) * BigInt(modelBlend);
  const denominator = BigInt(baseBlend);
  return Number((numerator + denominator - 1n) / denominator);
}

export function budgetText(cents) {
  return `${cents / CENTS_PER_DOLLAR}${USD_SUFFIX}`;
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

export function modelBlend(prices, model) {
  if (model === null) return null;
  const cost = prices.getModel(model.provider, model.id)?.cost;
  if (!cost) return null;
  const blend = blend100(cost);
  return blend > 0 ? blend : null;
}

function basePriceError(prices, config) {
  const model = parseBaseModel(config.base_model);
  const cost = prices.getModel(model.provider, model.id)?.cost;
  if (!cost) return "key base_model: pi gives no model";
  const tier = highestTierCost(cost);
  const missing = BASE_PRICE_KEYS.find((key) => !(tier[key] > 0));
  if (missing === undefined) return null;
  return `key base_model: the model has no ${missing} price`;
}

export function priceRatio(prices, config) {
  const base = modelBlend(prices, parseBaseModel(config.base_model));
  const run = modelBlend(prices, parseModelSelection(config.model));
  return { base, run, r: run === null ? null : run / base };
}

export function computeBaseCost(listPriceUsd, r) {
  if (r === null) return 0;
  return listPriceUsd / r;
}

export function checkStartGate(currentSum, reserve, capUsd) {
  return currentSum + reserve <= capUsd;
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

export function captureAuthState(authPath) {
  const st = lstatSync(authPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const digest = createHash("sha256")
    .update(readFileSync(authPath))
    .digest("hex");
  const entries = readdirSync(dirname(authPath)).sort();
  return { digest, mode: st.mode & MODE_MASK, entries };
}

export function refreshedAuthBreach(current, saved) {
  if (!current || current.mode !== FILE_MODE) return true;
  return current.entries.join("\n") !== saved.entries.join("\n");
}

export function checkAuthFileBreach(authPath, saved) {
  const current = captureAuthState(authPath);
  if (refreshedAuthBreach(current, saved)) return true;
  return current.digest !== saved.digest || saved.mode !== FILE_MODE;
}

export function extractCredentialValues(authPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const values = [];
  for (const entry of Object.values(parsed)) {
    if (!isObject(entry)) continue;
    if (entry.type === API_KEY_TYPE) values.push(entry.key);
    if (entry.type === OAUTH_TYPE) values.push(entry.refresh, entry.access);
  }
  return values.filter((value) => typeof value === "string" && value !== "");
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

function countCredentialInFile(path, credValues) {
  if (!existsSync(path)) return 0;
  return countCredentialInText(readFileSync(path, "latin1"), credValues);
}

export function removeRunFilesOnCredential(runDir, credValues) {
  const paths = [join(runDir, "diff.patch"), join(runDir, "check.txt")];
  let count = 0;
  for (const path of paths) count += countCredentialInFile(path, credValues);
  if (count > 0) for (const path of paths) rmSync(path, { force: true });
  return count;
}

export function breachCheckLine(run, breach) {
  return {
    case: run.caseId,
    repeat: run.repeat,
    session: run.sessionPath,
    a1: false,
    a2: false,
    a3: false,
    a4: false,
    pass: false,
    breach,
  };
}

function headerPath(line) {
  const rest = line.slice(DIFF_HEADER.length);
  const length = (rest.length - DIFF_HEADER_OVERHEAD) / 2;
  if (!Number.isInteger(length) || length < 1) return null;
  const path = rest.slice(2, 2 + length);
  return rest === `a/${path} b/${path}` ? path : null;
}

function addedText(line) {
  if (!line.startsWith("+") || line.startsWith("+++ ")) return null;
  return line.slice(1);
}

export function checkScope(diffPatch, allowed) {
  for (const line of diffPatch.split("\n")) {
    if (line.startsWith(DIFF_HEADER)) {
      const path = headerPath(line);
      if (path === null) return { pass: false, reason: "scope: path form" };
      if (!allowed.some((glob) => matchesGlob(path, glob)))
        return { pass: false, reason: `scope: path ${path} not in allowed` };
    }
    if (LINK_MODE_RE.test(line))
      return { pass: false, reason: "scope: symbolic link or submodule" };
    const added = addedText(line);
    if (added !== null && CONFLICT_MARKERS.some((m) => added.startsWith(m)))
      return { pass: false, reason: "scope: conflict marker" };
  }
  return { pass: true };
}

function helperStrings(text, start) {
  const strings = [];
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (QUOTES.includes(ch)) {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) break;
      strings.push(text.slice(i + 1, end));
      i = end;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  return strings.filter((value) => !value.includes(TEMPLATE_EXPRESSION));
}

function classValues(text) {
  const values = [];
  for (const m of text.matchAll(CLASS_ATTRIBUTE_RE))
    values.push(m[1] ?? m[2] ?? "");
  for (const m of text.matchAll(CLASS_HELPER_RE))
    values.push(...helperStrings(text, m.index + m[0].length));
  return values;
}

function utilityOf(token) {
  let depth = 0;
  let utility = "";
  for (const ch of token) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === ":" && depth === 0) utility = "";
    else utility += ch;
  }
  return utility;
}

function arbitraryToken(text) {
  for (const value of classValues(text)) {
    for (const token of value.split(/\s+/)) {
      if (utilityOf(token).includes("[")) return token;
    }
  }
  return null;
}

export function checkFrontend(diffPatch) {
  let path = "";
  for (const line of diffPatch.split("\n")) {
    if (line.startsWith(DIFF_HEADER)) {
      path = headerPath(line) ?? "";
      continue;
    }
    if (line.startsWith(NEW_FILE_PREFIX) && path.endsWith(CSS_EXTENSION))
      return { pass: false, reason: "frontend: added CSS file" };
    const added = addedText(line);
    if (added === null) continue;
    if (!FRONTEND_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
    const token = arbitraryToken(added);
    if (token !== null)
      return { pass: false, reason: `frontend: arbitrary value ${token}` };
  }
  return { pass: true };
}

export function gradeCheckRecord(end, aspects, breach) {
  if (breach)
    return { a1: false, a2: false, a3: false, a4: false, pass: false, breach };
  const { a1, a2, a3, a4 } = aspects;
  const pass = end === END_COMPLETED && a1 && a2 && a3 && a4;
  return { a1, a2, a3, a4, pass, breach: null };
}

export function computeGate(checks, cases, options) {
  const kindOf = new Map(cases.map((entry) => [entry.id, entry.kind]));
  const shares = [];
  for (const kind of KIND_VALUES) {
    const planned =
      cases.filter((entry) => entry.kind === kind).length * options.repeats;
    if (planned === 0) continue;
    const passes = checks.filter(
      (line) => kindOf.get(line.case) === kind && line.pass && !line.breach,
    ).length;
    shares.push({ kind, passes, planned });
  }
  const breaches = checks.filter((line) => line.breach).length;
  const planned = cases.length * options.repeats;
  let verdict = VERDICT_PASS;
  if (shares.some((s) => s.passes / s.planned < options.gateShare))
    verdict = VERDICT_FAIL;
  if (checks.length < planned) verdict = VERDICT_NONE;
  if (breaches > 0) verdict = VERDICT_FAIL;
  return { verdict, shares, breaches };
}

export function runActionForExit(exitCode, stderrText) {
  if (stderrText.includes(PROMPT_TEXT_PATH_CODE)) return ACTION_STOP;
  return GRADED_RUN_EXITS.includes(exitCode) ? ACTION_GRADE : ACTION_STOP;
}

function isUseEnvProxy(token) {
  const option = token.replaceAll('"', "");
  return option === "--use-env-proxy" || option.startsWith("--use-env-proxy=");
}

export function checkProxyEnv(env, execArgv) {
  if (env.NODE_USE_ENV_PROXY !== undefined) return true;
  if ((env.NODE_OPTIONS ?? "").split(/\s+/).some(isUseEnvProxy)) return true;
  return execArgv.some(isUseEnvProxy);
}

function messageText(message) {
  const { role, content } = message;
  if (role === "toolResult") {
    const text = (Array.isArray(content) ? content : [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    return text.slice(0, TRANSCRIPT_TOOL_RESULT_LIMIT);
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  return "";
}

export function writeTranscript(sessionPath, transcriptPath) {
  const lines = [];
  if (!existsSync(sessionPath)) {
    writeFileSync(transcriptPath, "", { mode: FILE_MODE });
    return;
  }
  for (const raw of readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.type !== TRANSCRIPT_ENTRY_TYPE) continue;
    const { id, message } = entry;
    if (!message) continue;
    lines.push(
      `## ${id}`,
      "",
      `Role: ${message.role}`,
      "",
      messageText(message),
      "",
    );
  }
  writeFileSync(transcriptPath, lines.join("\n"), { mode: FILE_MODE });
}

function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseDiagnosis(text, end) {
  if (end !== END_COMPLETED) return { valid: false, findings: [] };
  if (typeof text !== "string") return { valid: false, findings: [] };
  const objects = extractJsonObjects(text);
  if (objects.length !== 1) return { valid: false, findings: [] };
  let parsed;
  try {
    parsed = JSON.parse(objects[0]);
  } catch {
    return { valid: false, findings: [] };
  }
  if (!isObject(parsed)) return { valid: false, findings: [] };
  if (Object.keys(parsed).length !== 1 || !Array.isArray(parsed.findings))
    return { valid: false, findings: [] };
  if (parsed.findings.length > MAX_FINDINGS)
    return { valid: false, findings: [] };
  for (const finding of parsed.findings) {
    if (!isObject(finding)) return { valid: false, findings: [] };
    if (Object.keys(finding).length !== 3)
      return { valid: false, findings: [] };
    if (!DIAGNOSIS_ASPECTS.includes(finding.aspect))
      return { valid: false, findings: [] };
    if (
      typeof finding.evidence !== "string" ||
      finding.evidence.length < 1 ||
      finding.evidence.length > EVIDENCE_MAX
    )
      return { valid: false, findings: [] };
    if (!DIAGNOSIS_SEVERITIES.includes(finding.severity))
      return { valid: false, findings: [] };
  }
  return { valid: true, findings: parsed.findings };
}

export function runAgentArgsJudge(run, judgeWorkspace, judgeSessionPath) {
  const runnerDir = dirname(SCRIPT_PATH);
  const args = ["run", "agent", PROFILE_RE, "--model", run.config.judge_model];
  args.push("--budget", JUDGE_WALL);
  if (run.judgeRatio.run !== null) {
    const cents = parseUsdCents(run.config.judge_usd);
    const scaled = scaleUsdCents(
      cents,
      run.judgeRatio.run,
      run.judgeRatio.base,
    );
    args.push("--budget", budgetText(scaled));
  }
  args.push("--system-prompt", join(runnerDir, "judge.md"));
  args.push("--workspace", judgeWorkspace);
  args.push("--session", judgeSessionPath);
  args.push("--output", run.resultsPath);
  args.push("--prompt", join(runnerDir, "judge-task.md"));
  return args;
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function appendJsonLine(path, obj) {
  appendFileSync(path, `${JSON.stringify(obj)}\n`, { mode: FILE_MODE });
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function git(cwd, args, stdout) {
  return spawnSync("git", args, {
    cwd,
    env: isolatedGitEnvironment(process.env),
    encoding: "utf8",
    stdio: ["ignore", stdout ?? "pipe", "ignore"],
  });
}

function gitOutput(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function cloneSteps(bundlePath, destDir, commit) {
  const steps = [
    [undefined, ["clone", "--no-hardlinks", bundlePath, destDir]],
    [destDir, ["checkout", "--detach", commit]],
    [destDir, ["remote", "remove", "origin"]],
    [destDir, ["reflog", "expire", "--expire=now", "--all"]],
  ];
  for (const [cwd, args] of steps) {
    if (git(cwd, args).status !== 0) return null;
  }
  return readFileSync(join(destDir, ".git", "config"));
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

function restoreGitFiles(workspace, savedConfig) {
  try {
    const configPath = join(workspace, ".git", "config");
    rmSync(configPath, { recursive: true, force: true });
    writeFileSync(configPath, savedConfig);
    rmSync(join(workspace, ".git", "info", "attributes"), {
      recursive: true,
      force: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function diffSteps(workspace, commit, options) {
  if (!restoreGitFiles(workspace, options.savedConfig)) return false;
  if (git(workspace, ["add", "-A"]).status !== 0) return false;
  const fd = openSync(options.diffPath, "w", FILE_MODE);
  try {
    if (git(workspace, [...diffArgs(), commit], fd).status === 0) return true;
  } finally {
    closeSync(fd);
  }
  rmSync(options.diffPath, { force: true });
  return false;
}

function replaceEntry(path, isDirectory) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && !(isDirectory && st.isDirectory()))
    rmSync(path, { recursive: true, force: true });
  if (isDirectory) mkdirSync(path, { recursive: true });
}

export function copyHiddenTests(testsDir, gradingDir) {
  try {
    const entries = readdirSync(testsDir, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const source = join(entry.parentPath, entry.name);
      const parts = relative(testsDir, source).split(sep);
      let dest = gradingDir;
      for (const part of parts.slice(0, -1)) {
        dest = join(dest, part);
        replaceEntry(dest, true);
      }
      dest = join(dest, parts[parts.length - 1]);
      replaceEntry(dest, false);
      copyFileSync(source, dest);
    }
    return true;
  } catch {
    return false;
  }
}

function appendCheckText(checkTxtPath, part) {
  const header = `--- ${part.mode} (exit ${part.exit}) ---\n`;
  appendFileSync(checkTxtPath, `${header}${part.text}\n`, { mode: FILE_MODE });
}

function runCheckMode(grade, mode) {
  const result = spawnSync(
    "sh",
    [join(grade.caseFolder, "check", "check.sh"), grade.gradingDir, mode],
    { cwd: grade.gradingDir, encoding: "utf8", maxBuffer: CHECK_OUTPUT_LIMIT },
  );
  const exit = result.status ?? EXIT_STOP;
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  appendCheckText(grade.checkTxtPath, { mode, exit, text });
  return exit === EXIT_OK;
}

function runSetup(caseFolder, cwd) {
  const result = spawnSync("sh", [join(caseFolder, "setup.sh")], {
    cwd,
    stdio: "ignore",
  });
  return result.status === EXIT_OK;
}

function applyDiff(grade) {
  if (statSync(grade.diffPath).size === 0) return true;
  const args = ["apply", "--binary", grade.diffPath];
  if (git(grade.gradingDir, args).status === 0) return true;
  appendCheckText(grade.checkTxtPath, {
    mode: MODE_APPLY,
    exit: EXIT_STOP,
    text: "",
  });
  return false;
}

export function gradeRun(grade) {
  const { caseFolder, caseJson, gradingDir } = grade;
  const bundle = join(caseFolder, "repo.bundle");
  if (cloneSteps(bundle, gradingDir, caseJson.commit) === null)
    return { stop: "the grading clone failed" };
  if (!runSetup(caseFolder, gradingDir))
    return { stop: "setup.sh failed in the grading clone" };
  const diffText = readFileSync(grade.diffPath, "latin1");
  const a3 = checkScope(diffText, caseJson.allowed).pass;
  const failed = { a1: false, a2: false, a3, a4: false };
  if (!applyDiff(grade)) return { aspects: failed };
  const frontend =
    caseJson.kind !== KIND_FRONTEND || checkFrontend(diffText).pass;
  const a4 = runCheckMode(grade, MODE_CONVENTIONS) && frontend;
  if (!copyHiddenTests(join(caseFolder, "check", "tests"), gradingDir))
    return { aspects: { ...failed, a4 } };
  const a1 = runCheckMode(grade, MODE_FAIL_TO_PASS);
  const a2 = runCheckMode(grade, MODE_PASS_TO_PASS);
  return { aspects: { a1, a2, a3, a4 } };
}

export function runAgentArgs(run, workspace) {
  const args = ["run", "agent", PROFILE_SWE, "--model", run.config.model];
  args.push("--budget", run.caseJson.wall);
  if (run.ratio.run !== null) {
    const cents = parseUsdCents(run.caseJson.usd);
    const scaled = scaleUsdCents(cents, run.ratio.run, run.ratio.base);
    args.push("--budget", budgetText(scaled));
  }
  if (run.stage === BINDING_STAGE) {
    const binding = join(run.evalSetDir, "binding", `${run.caseJson.kind}.md`);
    args.push("--system-prompt", binding);
  }
  args.push("--workspace", workspace, "--session", run.sessionPath);
  args.push("--output", run.resultsPath);
  args.push("--prompt", join(run.caseFolder, "task.md"));
  return args;
}

function runAgentProcess(args, stderrPath) {
  const fd = openSync(stderrPath, "w", FILE_MODE);
  try {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "ignore", fd],
    });
    return result.status ?? EXIT_STOP;
  } finally {
    closeSync(fd);
  }
}

function makeRoot(workBaseDir) {
  const root = join(workBaseDir, randomName());
  mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
  return root;
}

function breachStop(run, breach) {
  appendJsonLine(run.checksPath, breachCheckLine(run, breach));
  return { stop: STOP_BREACH, breach };
}

function credentialStop(run, count) {
  process.stdout.write(`evaluation: breach credential, count ${count}\n`);
  return breachStop(run, BREACH_CREDENTIAL);
}

async function refreshForRun(run, deps) {
  const provider = parseModelSelection(run.config.model).provider;
  const validity = parseWallMs(run.caseJson.wall) + REFRESH_MARGIN_MS;
  try {
    await deps.refresh(run.authPath, provider, validity);
    return true;
  } catch {
    return false;
  }
}

async function refreshForJudge(run, deps) {
  const provider = parseModelSelection(run.config.judge_model).provider;
  const validity = parseWallMs(JUDGE_WALL) + REFRESH_MARGIN_MS;
  try {
    await deps.refresh(run.authPath, provider, validity);
    return true;
  } catch {
    return false;
  }
}

function nextJudgeAttempt(runDir) {
  let n = 1;
  while (existsSync(join(runDir, `judge-${n}.jsonl`))) n++;
  return n;
}

function resultEnd(run) {
  const line = readJsonLines(run.resultsPath).findLast(
    (entry) => entry.session === run.sessionPath,
  );
  return line?.end ?? END_ABSENT;
}

function gradeDiff(run, roots) {
  const gradingRoot = makeRoot(run.workBaseDir);
  roots.push(gradingRoot);
  return gradeRun({
    caseFolder: run.caseFolder,
    caseJson: run.caseJson,
    gradingDir: join(gradingRoot, GRADING_NAME),
    diffPath: join(run.runDir, "diff.patch"),
    checkTxtPath: join(run.runDir, "check.txt"),
  });
}

function gradeWorkspace(run, session, roots) {
  const diffPath = join(run.runDir, "diff.patch");
  const diffOptions = { savedConfig: session.savedConfig, diffPath };
  let aspects = { a1: false, a2: false, a3: false, a4: false };
  if (diffSteps(session.workspace, run.caseJson.commit, diffOptions)) {
    const diffCount = removeRunFilesOnCredential(run.runDir, run.credValues);
    if (diffCount > 0) return credentialStop(run, diffCount);
    const graded = gradeDiff(run, roots);
    if (graded.stop) return graded;
    const checkCount = removeRunFilesOnCredential(run.runDir, run.credValues);
    if (checkCount > 0) return credentialStop(run, checkCount);
    aspects = graded.aspects;
  }
  appendJsonLine(run.checksPath, {
    case: run.caseId,
    repeat: run.repeat,
    session: run.sessionPath,
    ...gradeCheckRecord(resultEnd(run), aspects, null),
  });
  if (run.set === SET_HELD_OUT)
    rmSync(join(run.runDir, "check.txt"), { force: true });
  return { stop: null };
}

async function runDiagnosis(run, judgeRoot, deps) {
  const judgeWorkspace = join(judgeRoot, JUDGE_DIR);
  mkdirSync(judgeWorkspace, { recursive: true, mode: DIRECTORY_MODE });
  writeTranscript(run.sessionPath, join(judgeWorkspace, "transcript.md"));
  for (const name of ["diff.patch", "check.txt"]) {
    const src = join(run.runDir, name);
    if (existsSync(src)) copyFileSync(src, join(judgeWorkspace, name));
  }
  const checkLine = readJsonLines(run.checksPath).findLast(
    (line) => line.case === run.caseId && line.repeat === run.repeat,
  );
  writeFileSync(
    join(judgeWorkspace, "check.json"),
    `${JSON.stringify(checkLine ?? {})}\n`,
    { mode: FILE_MODE },
  );
  copyFileSync(
    join(run.caseFolder, "task.md"),
    join(judgeWorkspace, "task.md"),
  );
  if (run.stage === BINDING_STAGE) {
    const binding = join(run.evalSetDir, "binding", `${run.caseJson.kind}.md`);
    copyFileSync(binding, join(judgeWorkspace, `${run.caseJson.kind}.md`));
  }
  const sum = baseCostSum(run.resultsPath, run.ratio.r, run.judgeRatio.r);
  const judgeReserve = parseUsdCents(run.config.judge_usd) / CENTS_PER_DOLLAR;
  if (!checkStartGate(sum, judgeReserve, run.config.cap_usd))
    return { stop: STOP_CAP };
  const attemptN = nextJudgeAttempt(run.runDir);
  const judgeSessionPath = join(run.runDir, `judge-${attemptN}.jsonl`);
  const judgeStderrPath = join(run.runDir, `judge-${attemptN}-stderr.txt`);
  if (!(await refreshForJudge(run, deps)))
    return { stop: "the credential refresh failed" };
  const refreshed = captureAuthState(run.authPath);
  if (refreshedAuthBreach(refreshed, run.authStart))
    return breachStop(run, BREACH_AUTH_FILE);
  for (const value of extractCredentialValues(run.authPath))
    run.credValues.add(value);
  const exit = deps.runAgent(
    runAgentArgsJudge(run, judgeWorkspace, judgeSessionPath),
    judgeStderrPath,
  );
  const count = countCredentialInFile(judgeSessionPath, run.credValues);
  if (count > 0) return credentialStop(run, count);
  if (checkAuthFileBreach(run.authPath, refreshed))
    return breachStop(run, BREACH_AUTH_FILE);
  const stderrText = readFileSync(judgeStderrPath, "latin1");
  if (runActionForExit(exit, stderrText) === ACTION_STOP)
    return { stop: `judge exit ${exit}` };
  const resultLine = readJsonLines(run.resultsPath).findLast(
    (line) => line.agent === PROFILE_RE && line.session === judgeSessionPath,
  );
  const { valid, findings } = parseDiagnosis(
    resultLine?.text ?? null,
    resultLine?.end ?? END_ABSENT,
  );
  appendJsonLine(run.diagnosesPath, {
    session: judgeSessionPath,
    valid,
    findings,
  });
  return { stop: null };
}

async function evaluateInRoots(run, deps, roots) {
  const workspace = join(roots[0], WORKSPACE_NAME);
  const bundle = join(run.caseFolder, "repo.bundle");
  const savedConfig = cloneSteps(bundle, workspace, run.caseJson.commit);
  if (savedConfig === null) return { stop: "the workspace clone failed" };
  if (!runSetup(run.caseFolder, workspace))
    return { stop: "setup.sh failed in the workspace" };
  if (!(await refreshForRun(run, deps)))
    return { stop: "the credential refresh failed" };
  const refreshed = captureAuthState(run.authPath);
  if (refreshedAuthBreach(refreshed, run.authStart))
    return breachStop(run, BREACH_AUTH_FILE);
  for (const value of extractCredentialValues(run.authPath))
    run.credValues.add(value);
  mkdirSync(run.runDir, { recursive: true, mode: DIRECTORY_MODE });
  const stderrPath = join(run.runDir, "stderr.txt");
  const exit = deps.runAgent(runAgentArgs(run, workspace), stderrPath);
  const count = countCredentialInFile(run.sessionPath, run.credValues);
  if (count > 0) return credentialStop(run, count);
  if (checkAuthFileBreach(run.authPath, refreshed))
    return breachStop(run, BREACH_AUTH_FILE);
  const stderrText = readFileSync(stderrPath, "latin1");
  if (runActionForExit(exit, stderrText) === ACTION_STOP)
    return { stop: `run agent exit ${exit}` };
  const gradeResult = gradeWorkspace(run, { workspace, savedConfig }, roots);
  if (gradeResult.stop) return gradeResult;
  if (run.set === SET_DEV) {
    const judgeRoot = makeRoot(run.workBaseDir);
    roots.push(judgeRoot);
    return runDiagnosis(run, judgeRoot, deps);
  }
  return gradeResult;
}

export async function evaluateRun(run, deps) {
  const roots = [makeRoot(run.workBaseDir)];
  try {
    return await evaluateInRoots(run, deps, roots);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

function readCases(evalSetDir, set) {
  const casesDir = join(evalSetDir, "cases", set);
  const names = existsSync(casesDir) ? readdirSync(casesDir).sort() : [];
  const cases = [];
  for (const id of names) {
    const folder = join(casesDir, id);
    if (!lstatSync(folder).isDirectory()) continue;
    const json = readJsonFile(join(folder, "case.json"));
    const error = validateCase(json);
    if (error) return { error: `case ${id}: ${error}` };
    cases.push({ id, folder, json, kind: json.kind });
  }
  if (cases.length === 0) return { error: `no case in ${casesDir}` };
  return { cases };
}

async function readConfiguration(evalSetDir, readPrices) {
  const path = join(evalSetDir, "config.json");
  const config = readJsonFile(path);
  const error = validateConfig(config);
  if (error) return { error: `${path}: ${error.message}` };
  const prices = await readPrices();
  const priceError = basePriceError(prices, config);
  if (priceError) return { error: `${path}: ${priceError}` };
  return {
    config,
    ratio: priceRatio(prices, config),
    judgeRatio: priceRatio(prices, { ...config, model: config.judge_model }),
  };
}

function heldOutEvaluations(resultsBaseDir, stage) {
  if (!existsSync(resultsBaseDir)) return [];
  const found = [];
  for (const id of readdirSync(resultsBaseDir).sort()) {
    const path = join(resultsBaseDir, id, "iteration.json");
    const iteration = readJsonFile(path);
    if (iteration?.set !== SET_HELD_OUT || iteration.stage !== stage) continue;
    found.push({ id, iteration, startedMs: statSync(path).mtimeMs });
  }
  return found;
}

function parseRunOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        evaluation: { type: "string" },
        stage: { type: "string" },
        set: { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    return { error: err.message };
  }
  if (!values.evaluation || !EVAL_ID_RE.test(values.evaluation))
    return { error: "--evaluation holds letters, digits, - and _" };
  if (!STAGE_VALUES.includes(values.stage))
    return { error: "--stage is 1 or 2" };
  if (!SET_VALUES.includes(values.set))
    return { error: "--set is dev or held-out" };
  return {
    evalId: values.evaluation,
    stage: Number(values.stage),
    set: values.set,
  };
}

function engineCommit(engineRoot) {
  const status = gitOutput(engineRoot, ["status", "--porcelain"]);
  if (status !== "") return null;
  return gitOutput(engineRoot, ["rev-parse", "HEAD"]);
}

function iterationError(plan, existing) {
  if (existing === undefined) {
    if (plan.set !== SET_HELD_OUT) return null;
    const other = heldOutEvaluations(plan.resultsBaseDir, plan.stage).find(
      (entry) => entry.iteration.gate_share !== plan.config.gate_share,
    );
    return other ? `gate_share differs from evaluation ${other.id}` : null;
  }
  if (existing.stage !== plan.stage) return "--stage differs from iteration";
  if (existing.set !== plan.set) return "--set differs from iteration";
  if (existing.set_commit !== plan.setCommit)
    return "set_commit differs from the HEAD of the evaluation set";
  return null;
}

function newIteration(plan) {
  return {
    stage: plan.stage,
    set: plan.set,
    set_commit: plan.setCommit,
    engine_commit: plan.engineCommit,
    repeats: plan.config.repeats,
    gate_share: plan.set === SET_HELD_OUT ? plan.config.gate_share : null,
    parent: null,
    replicate: null,
    aspect: null,
    hypothesis: null,
  };
}

async function buildPlan(start, options) {
  const commit = engineCommit(start.engineRoot);
  if (commit === null) return { error: "the engine tree is dirty" };
  const dirs = directories(start.env);
  const evalSetDir = join(dirs.data, "evaluation", "agent");
  const read = await readConfiguration(evalSetDir, start.readPrices);
  if (read.error) return read;
  const setCommit = gitOutput(evalSetDir, ["rev-parse", "HEAD"]);
  if (setCommit === null) return { error: `no set commit in ${evalSetDir}` };
  const cases = readCases(evalSetDir, options.set);
  if (cases.error) return cases;
  const authStart = captureAuthState(start.authPath);
  if (authStart === null) return { error: "auth.json is no regular file" };
  const resultsBaseDir = join(dirs.state, "evaluation", "runs");
  return {
    ...options,
    ...read,
    cases: cases.cases,
    engineCommit: commit,
    setCommit,
    evalSetDir,
    resultsBaseDir,
    resultsDir: join(resultsBaseDir, options.evalId),
    workBaseDir: join(dirs.state, "evaluation", "work"),
    authPath: start.authPath,
    authStart,
  };
}

export async function startRun(start) {
  if (checkProxyEnv(start.env, start.execArgv))
    return { error: "NODE_USE_ENV_PROXY or --use-env-proxy is set" };
  const options = parseRunOptions(start.argv);
  if (options.error) return options;
  const plan = await buildPlan(start, options);
  if (plan.error) return plan;
  const iterationPath = join(plan.resultsDir, "iteration.json");
  const existing = existsSync(iterationPath)
    ? JSON.parse(readFileSync(iterationPath, "utf8"))
    : undefined;
  const error = iterationError(plan, existing);
  if (error) return { error };
  mkdirSync(plan.resultsDir, { recursive: true, mode: DIRECTORY_MODE });
  plan.iteration = existing ?? newIteration(plan);
  if (existing === undefined)
    writeFileSync(iterationPath, `${JSON.stringify(plan.iteration)}\n`, {
      mode: FILE_MODE,
    });
  appendJsonLine(join(plan.resultsDir, "calls.jsonl"), {
    cap_usd: plan.config.cap_usd,
  });
  return plan;
}

function baseCostSum(resultsPath, sweR, judgeR) {
  let sum = 0;
  for (const line of readJsonLines(resultsPath)) {
    const r = line.agent === PROFILE_RE ? (judgeR ?? null) : (sweR ?? null);
    sum += computeBaseCost(line.list_price_usd ?? 0, r);
  }
  return sum;
}

function planRun(plan, entry, repeat) {
  const runDir = join(plan.resultsDir, entry.id, `${repeat}-1`);
  return {
    caseId: entry.id,
    caseFolder: entry.folder,
    caseJson: entry.json,
    repeat,
    runDir,
    sessionPath: join(runDir, "session.jsonl"),
    resultsPath: join(plan.resultsDir, "results.jsonl"),
    checksPath: join(plan.resultsDir, "checks.jsonl"),
    diagnosesPath: join(plan.resultsDir, DIAGNOSES_FILE),
    workBaseDir: plan.workBaseDir,
    evalSetDir: plan.evalSetDir,
    authPath: plan.authPath,
    authStart: plan.authStart,
    credValues: plan.credValues,
    config: plan.config,
    ratio: plan.ratio,
    judgeRatio: plan.judgeRatio,
    stage: plan.stage,
    set: plan.set,
  };
}

function pendingRuns(plan) {
  const done = new Set(
    readJsonLines(join(plan.resultsDir, "checks.jsonl")).map(
      (line) => `${line.case}:${line.repeat}`,
    ),
  );
  const runs = [];
  for (const entry of plan.cases) {
    for (let repeat = 1; repeat <= plan.iteration.repeats; repeat++) {
      if (!done.has(`${entry.id}:${repeat}`))
        runs.push(planRun(plan, entry, repeat));
    }
  }
  return runs;
}

async function runPending(plan, deps) {
  plan.credValues = new Set(extractCredentialValues(plan.authPath));
  for (const run of pendingRuns(plan)) {
    const sum = baseCostSum(run.resultsPath, plan.ratio.r, plan.judgeRatio.r);
    const reserve = parseUsdCents(run.caseJson.usd) / CENTS_PER_DOLLAR;
    if (!checkStartGate(sum, reserve, plan.config.cap_usd))
      return { stop: STOP_CAP };
    const result = await evaluateRun(run, deps);
    if (result.stop) return result;
  }
  return { stop: null };
}

export async function runPlan(plan, deps) {
  const result = await runPending(plan, deps);
  writeReport(plan);
  if (result.stop === null) return EXIT_OK;
  const reason = result.breach ? `breach ${result.breach}` : result.stop;
  process.stderr.write(`evaluation: stop: ${reason}\n`);
  return result.stop === STOP_CAP ? EXIT_CAP : EXIT_STOP;
}

function caseOfSession(session) {
  return basename(dirname(dirname(session)));
}

function firstDifference(lines, key) {
  const text = (entry) => JSON.stringify(entry.line[key]);
  const other = lines.find((entry) => text(entry) !== text(lines[0]));
  if (other === undefined) return null;
  return { key, lines: [lines[0].number, other.number] };
}

export function checkResultKeys(resultLines) {
  const numbered = resultLines.map((line, index) => ({
    line,
    number: index + 1,
  }));
  const version = firstDifference(numbered, "engine_version");
  if (version) return version;
  const swe = numbered.filter((entry) => entry.line.agent === PROFILE_SWE);
  for (const key of RESULT_KEYS) {
    const difference = firstDifference(swe, key);
    if (difference) return difference;
  }
  const byCase = Map.groupBy(swe, (entry) =>
    caseOfSession(String(entry.line.session)),
  );
  for (const lines of byCase.values()) {
    for (const key of CASE_KEYS) {
      const difference = firstDifference(lines, key);
      if (difference) return difference;
    }
  }
  const re = numbered.filter((entry) => entry.line.agent === PROFILE_RE);
  for (const key of RESULT_KEYS) {
    const difference = firstDifference(re, key);
    if (difference) return difference;
  }
  return null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function numberText(value) {
  if (value === null) return NONE_TEXT;
  return String(Number(value.toFixed(6)));
}

function shareText(part, whole) {
  if (whole === 0) return NONE_TEXT;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function goodOnAspect(diagnoses, aspect, check) {
  const runDir = dirname(check.session);
  const diag = diagnoses.findLast((d) => dirname(d.session) === runDir);
  if (!diag || !diag.valid) return false;
  return !diag.findings.some(
    (f) =>
      f.aspect === aspect && (f.severity === "high" || f.severity === "medium"),
  );
}

function findingsForAspect(diagnoses, aspect, severity) {
  return diagnoses.reduce(
    (count, d) =>
      count +
      (d.valid
        ? d.findings.filter(
            (f) => f.aspect === aspect && f.severity === severity,
          ).length
        : 0),
    0,
  );
}

function goalLines(report, joined) {
  const { checks } = report;
  const costs = joined.map((line) =>
    computeBaseCost(line.list_price_usd ?? 0, report.r),
  );
  const medianOf = (key) => numberText(median(joined.map((line) => line[key])));
  const breaches = checks.filter((line) => line.breach);
  const names = [...new Set(breaches.map((line) => line.breach))].join(", ");
  const ends = Map.groupBy(joined, (line) => line.end);
  const endText = [...ends].map(([end, lines]) => `${end} ${lines.length}`);
  const planned = report.cases.length * report.iteration.repeats;
  const lines = ["## Goals", ""];
  for (const aspect of ["a1", "a2", "a3", "a4"]) {
    const good = checks.filter((line) => line[aspect]).length;
    lines.push(`${aspect.toUpperCase()} good runs: ${good}`);
  }
  if (report.iteration.set === SET_DEV) {
    const diagnoses = report.diagnoses ?? [];
    const invalid = diagnoses.filter((d) => !d.valid).length;
    for (const aspect of ["A5", "A6", "A7"]) {
      const good = checks.filter((c) =>
        goodOnAspect(diagnoses, aspect, c),
      ).length;
      const counts = DIAGNOSIS_SEVERITIES.map(
        (sev) => `${findingsForAspect(diagnoses, aspect, sev)} ${sev}`,
      ).join(", ");
      lines.push(`${aspect} good runs: ${good}, findings: ${counts}`);
    }
    lines.push(`invalid diagnoses: ${invalid}`);
  }
  lines.push(
    `A8: base cost median ${numberText(median(costs))}, base cost sum ${numberText(costs.reduce((a, b) => a + b, 0))}, duration_ms median ${medianOf("duration_ms")}, model_calls median ${medianOf("model_calls")}, tool_calls median ${medianOf("tool_calls")}`,
    `A9 breaches: ${breaches.length}${names ? ` (${names})` : ""}`,
    `ends: ${endText.join(", ") || NONE_TEXT}`,
    `passes: ${checks.filter((line) => line.pass).length} of ${planned} planned runs`,
    "",
  );
  return lines;
}

function gateLines(report) {
  const { iteration } = report;
  const gate = computeGate(report.checks, report.cases, {
    repeats: iteration.repeats,
    gateShare: iteration.gate_share,
  });
  const shares = gate.shares.map(
    (s) => `pass share ${s.kind} ${shareText(s.passes, s.planned)}`,
  );
  const line = [
    ...shares,
    `gate_share ${iteration.gate_share}`,
    `breaches ${gate.breaches}`,
    `earlier held-out evaluations ${report.earlier}`,
    `verdict ${gate.verdict}`,
  ].join(", ");
  return { verdict: gate.verdict, lines: ["## Gate", "", `gate: ${line}`, ""] };
}

function agentCostBlock(results, r, label) {
  const lines = results.filter((line) => line.agent === label);
  const costs = lines.map((line) =>
    computeBaseCost(line.list_price_usd ?? 0, r),
  );
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const usage = (key) => sum(lines.map((line) => line.usage?.[key] ?? 0));
  const inputSide = usage("input") + usage("cache_read") + usage("cache_write");
  return [
    `${label}: list price ${numberText(sum(lines.map((line) => line.list_price_usd ?? 0)))}, r ${numberText(r)}, base cost ${numberText(sum(costs))}`,
    `${label}: base cost of one run: mean ${numberText(costs.length ? sum(costs) / costs.length : null)}, maximum ${numberText(costs.length ? Math.max(...costs) : null)}`,
    `${label}: cache-read share ${shareText(usage("cache_read"), inputSide)}, output ratio ${shareText(usage("output"), inputSide)}`,
  ];
}

function costLines(report) {
  const planned = report.cases.length * report.iteration.repeats;
  const diagnoses = report.diagnoses ?? [];
  const unstartedDiag =
    report.iteration.set === SET_DEV ? planned - diagnoses.length : null;
  return [
    "## Cost",
    "",
    ...agentCostBlock(report.results, report.r, PROFILE_SWE),
    ...agentCostBlock(report.results, report.judgeR ?? null, PROFILE_RE),
    `cap_usd of each call: ${report.calls.map((line) => line.cap_usd).join(", ") || NONE_TEXT}`,
    `unstarted runs: ${planned - report.checks.length}${unstartedDiag !== null ? `, unstarted diagnoses: ${unstartedDiag}` : ""}`,
    "",
  ];
}

function devCaseLines(report) {
  const { checks, cases, iteration } = report;
  const diagnoses = report.diagnoses ?? [];
  const lines = ["## Dev cases", ""];
  for (const c of cases) {
    const caseChecks = checks.filter((line) => line.case === c.id);
    const passes = caseChecks.filter((line) => line.pass).length;
    const good = (key) => caseChecks.filter((line) => line[key]).length;
    const goodDiag = (aspect) =>
      caseChecks.filter((c) => goodOnAspect(diagnoses, aspect, c)).length;
    lines.push(
      `case ${c.id}: passes ${passes}, A1 ${good("a1")}, A2 ${good("a2")}, A3 ${good("a3")}, A4 ${good("a4")}, A5 ${goodDiag("A5")}, A6 ${goodDiag("A6")}, A7 ${goodDiag("A7")}`,
    );
  }
  const planned = cases.length * iteration.repeats;
  const ceiling = cases.filter((c) => {
    const cc = checks.filter((line) => line.case === c.id);
    return cc.length > 0 && cc.every((line) => line.pass);
  }).length;
  const floor = cases.filter((c) => {
    const cc = checks.filter((line) => line.case === c.id);
    return cc.length > 0 && cc.every((line) => !line.pass);
  }).length;
  lines.push(
    "",
    `set-difficulty: ${ceiling} ceiling, ${floor} floor of ${cases.length}`,
    "",
  );
  const plannedDiagnoses = planned;
  const doneDiagnoses = diagnoses.length;
  const doneChecks = checks.length;
  const verdict =
    doneChecks >= planned && doneDiagnoses >= plannedDiagnoses
      ? VERDICT_COMPLETE
      : VERDICT_NONE;
  return { lines, verdict };
}

export function buildReport(report) {
  const { iteration } = report;
  const sessions = new Set(report.checks.map((line) => line.session));
  const joined = report.results.filter((line) => sessions.has(line.session));
  const lines = [
    `# Evaluation ${report.evalId}`,
    "",
    `stage: ${iteration.stage}`,
    `set: ${iteration.set}`,
    `set commit: ${iteration.set_commit}`,
    "",
    ...goalLines(report, joined),
  ];
  let verdict = null;
  if (iteration.set === SET_HELD_OUT) {
    const gate = gateLines(report);
    verdict = gate.verdict;
    lines.push(...gate.lines);
  }
  if (iteration.set === SET_DEV) {
    const dev = devCaseLines(report);
    verdict = dev.verdict;
    lines.push(...dev.lines);
    lines.push(`verdict ${verdict}`, "");
  }
  lines.push(...costLines(report));
  return { text: lines.join("\n"), verdict };
}

function writeReport(evaluation) {
  const { resultsDir, resultsBaseDir, evalId, iteration } = evaluation;
  const startedMs = statSync(join(resultsDir, "iteration.json")).mtimeMs;
  const earlier = heldOutEvaluations(resultsBaseDir, iteration.stage).filter(
    (entry) => entry.id !== evalId && entry.startedMs < startedMs,
  ).length;
  const diagnosesFile = join(resultsDir, DIAGNOSES_FILE);
  const diagnoses = existsSync(diagnosesFile)
    ? readJsonLines(diagnosesFile)
    : [];
  const report = buildReport({
    evalId,
    iteration,
    cases: evaluation.cases,
    r: evaluation.ratio.r,
    judgeR: evaluation.judgeRatio?.r ?? null,
    earlier,
    checks: readJsonLines(join(resultsDir, "checks.jsonl")),
    results: readJsonLines(join(resultsDir, "results.jsonl")),
    calls: readJsonLines(join(resultsDir, "calls.jsonl")),
    diagnoses,
  });
  writeFileSync(join(resultsDir, "report.md"), report.text, {
    mode: FILE_MODE,
  });
  return report.verdict;
}

function parseReportOptions(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { evaluation: { type: "string" } },
      strict: true,
    });
    if (values.evaluation && EVAL_ID_RE.test(values.evaluation))
      return { evalId: values.evaluation };
    return { error: "--evaluation holds letters, digits, - and _" };
  } catch (err) {
    return { error: err.message };
  }
}

export async function reportEvaluation(start) {
  const options = parseReportOptions(start.argv);
  if (options.error) return options;
  const dirs = directories(start.env);
  const resultsBaseDir = join(dirs.state, "evaluation", "runs");
  const resultsDir = join(resultsBaseDir, options.evalId);
  const iteration = readJsonFile(join(resultsDir, "iteration.json"));
  if (!isObject(iteration))
    return { error: `no iteration.json in ${resultsDir}` };
  const evalSetDir = join(dirs.data, "evaluation", "agent");
  const read = await readConfiguration(evalSetDir, start.readPrices);
  if (read.error) return read;
  const cases = readCases(evalSetDir, iteration.set);
  if (cases.error) return cases;
  const results = readJsonLines(join(resultsDir, "results.jsonl"));
  const difference = checkResultKeys(results);
  if (difference) {
    const [first, second] = difference.lines;
    return {
      error: `results.jsonl: lines ${first} and ${second} differ in ${difference.key}`,
    };
  }
  const verdict = writeReport({
    evalId: options.evalId,
    resultsDir,
    resultsBaseDir,
    iteration,
    cases: cases.cases,
    ratio: read.ratio,
    judgeRatio: read.judgeRatio,
  });
  return { verdict };
}

function refuse(text) {
  process.stderr.write(`evaluation: ${text}\n`);
  return EXIT_STOP;
}

async function runCommand(argv) {
  const plan = await startRun({
    argv,
    env: process.env,
    execArgv: process.execArgv,
    engineRoot: ENGINE_ROOT,
    authPath: join(userInfo().homedir, ".config", "kanthord", "auth.json"),
    readPrices: readModelPrices,
  });
  if (plan.error) return refuse(plan.error);
  return runPlan(plan, { refresh: refreshAuth, runAgent: runAgentProcess });
}

async function reportCommand(argv) {
  const result = await reportEvaluation({
    argv,
    env: process.env,
    readPrices: readModelPrices,
  });
  if (result.error) return refuse(result.error);
  return result.verdict === VERDICT_NONE ? EXIT_NO_VERDICT : EXIT_OK;
}

const COMMANDS = { run: runCommand, report: reportCommand };

async function main(argv) {
  if (!Object.hasOwn(COMMANDS, argv[0]))
    return refuse("the subcommand is run or report");
  return COMMANDS[argv[0]](argv.slice(1));
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === SCRIPT_PATH
) {
  process.exit(await main(process.argv.slice(2)));
}
