import { createHash, randomInt } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { platform, tmpdir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
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
import { findPatternText } from "../../../dist/agent/sensitive-text.js";

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
const BREACH_PROTECTED_PATH = "protected_path";
const BREACH_SET_CHANGE = "set_change";
const MANIFEST_FILE = "shared.sha256";
const SHARED_DIR = "shared";
const MANIFEST_TYPE_FILE = "F";
const MANIFEST_TYPE_LINK = "L";
const MANIFEST_TYPE_DIR = "D";
const MANIFEST_MODE_EXEC = "x";
const MANIFEST_MODE_NONE = "-";
const MANIFEST_CONCURRENCY = 64;
const MANIFEST_LINE =
  /^(?:F\t[0-9a-f]{64}\t[x-]|L\t[^\t]+\t-|D\t-\t-)\t[^\t]+$/;
const MANIFEST_REFUSED_TEXT = /[\t\n]/;
const PROTECTED_PATH_PARTS = ["evaluation/agent", "evaluation/runs", "/check/"];
const PROTECTED_FILE_NAMES = [
  "check.sh",
  "reference.patch",
  "checks.jsonl",
  "results.jsonl",
  "calls.jsonl",
  "diagnoses.jsonl",
  "iteration.json",
  "report.md",
  "config.json",
  "session.jsonl",
  "stderr.txt",
];
const PROTECTED_FILE_PREFIX = "judge-";
const PATH_BOUNDARY_CHARS = "/\"'`";
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
const EXIT_USAGE = 2;
const EXIT_NO_VERDICT = 3;
const EXIT_CAP = 4;
const GRADED_RUN_EXITS = [0, 4, 5];
const EXIT_RETRYABLE = 75;
const MAX_RETRYABLE = 3;
const PROMPT_TEXT_PATH_CODE = "cli.run.agent.prompt_text_path";
const ACTION_GRADE = "grade";
const ACTION_STOP = "stop";
const ACTION_RETRY = "retry";
const VERDICT_PASS = "pass";
const VERDICT_FAIL = "fail";
const VERDICT_NONE = "no verdict";
const STOP_BREACH = "breach";
const STOP_CAP = "cap";
const MIN_JOBS = 1;
const MAX_JOBS = 8;
const DEFAULT_JOBS = 4;
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
const TOOL_RESULT_ROLE = "toolResult";
const TEXT_PART = "text";
const TOOL_CALL_PART = "toolCall";
const SEVERITIES_NOT_GOOD = ["high", "medium"];
const DIAGNOSED_ASPECTS = ["A5", "A6", "A7"];
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
const SWE_GLOBAL_KEYS = ["provider", "model", "reasoning_effort"];
const KIND_KEYS = ["system_prompt_digest"];
const RESULT_KEYS = [...SWE_GLOBAL_KEYS, ...KIND_KEYS];
const CASE_KEYS = ["input_digest", "budget"];
const COMMON_KEYS = [
  "input_digest",
  "engine_version",
  "provider",
  "model",
  "reasoning_effort",
  "budget",
];
const DIGEST_KEY = "system_prompt_digest";
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
const ASPECT_VALUES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
const HYPOTHESIS_MAX_LENGTH = 500;
const ONE_CHANGE_FILES = [
  "static/prompt/role/swe@1.md",
  "static/prompt/swe@1.md",
];
const VERDICT_KEEP = "keep";
const VERDICT_REVERT = "revert";
const RE_COMPARE_KEYS = ["provider", "model", "reasoning_effort"];
const NOISE_FLOOR = 2;
const REFERENCE_TRIES = 3;
const SCRIPT_LIMIT_MS = 10 * 60000;
const EMPTY_GROUP_CODES = ["ESRCH", "EPERM"];
const GITLINK_MODE = "160000";
const SET_SYMLINK_MODE = "120000";
const SET_EXEC_MODE = "100755";
const SET_PLAIN_MODE = "100644";
const STAGED_DIFF_ARGS = [
  "diff",
  "--cached",
  "--raw",
  "-z",
  "--no-renames",
  "--abbrev=40",
  "--diff-filter=ACM",
];
const VALIDATE_FILES = [
  "repo.bundle",
  "setup.sh",
  "task.md",
  "check/check.sh",
  "check/tests",
  "check/reference.patch",
];

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

export function goodOnRunNoise(check, diagnosis, aspect, isParent) {
  const lc = aspect.toLowerCase();
  if (lc in check) return Boolean(check[lc]);
  if (!diagnosis?.valid) return isParent;
  return !diagnosis.findings.some(
    (f) => f.aspect === aspect && SEVERITIES_NOT_GOOD.includes(f.severity),
  );
}

export function flipsCountForAspect(checks, diagnoses, aspect, isParent) {
  const byCaseId = Map.groupBy(checks, (c) => c.case);
  let flips = 0;
  for (const caseChecks of byCaseId.values()) {
    const goods = caseChecks.filter((check) =>
      goodOnRunNoise(check, diagnosisOf(diagnoses, check), aspect, isParent),
    );
    if (goods.length > 0 && goods.length < caseChecks.length) flips++;
  }
  return flips;
}

export function passFlipsCount(checks) {
  const byCaseId = Map.groupBy(checks, (c) => c.case);
  let flips = 0;
  for (const caseChecks of byCaseId.values()) {
    const passes = caseChecks.filter((c) => c.pass).length;
    if (passes > 0 && passes < caseChecks.length) flips++;
  }
  return flips;
}

function distinctCount(lines, key) {
  return new Set(lines.map((line) => JSON.stringify(line[key]))).size;
}

function caseComparabilityError(lines, parentLines, isReplicate) {
  if (lines.length === 0 || parentLines.length === 0) return null;
  const both = [...lines, ...parentLines];
  const differing = COMMON_KEYS.find((key) => distinctCount(both, key) > 1);
  if (differing) return differing;
  if (isReplicate)
    return distinctCount(both, DIGEST_KEY) > 1 ? DIGEST_KEY : null;
  const digests = new Set(lines.map((line) => line[DIGEST_KEY]));
  return parentLines.some((line) => digests.has(line[DIGEST_KEY]))
    ? DIGEST_KEY
    : null;
}

export function comparabilityError(pair) {
  const { iteration, parentIteration } = pair;
  if (iteration.stage !== parentIteration.stage) return "stage";
  if (iteration.set_commit !== parentIteration.set_commit) return "set_commit";
  const ofCase = (lines, id) =>
    lines.filter(
      (line) =>
        line.agent === PROFILE_SWE &&
        caseOfSession(String(line.session)) === id,
    );
  for (const entry of pair.cases) {
    const error = caseComparabilityError(
      ofCase(pair.results, entry.id),
      ofCase(pair.parentResults, entry.id),
      Boolean(iteration.replicate),
    );
    if (error) return error;
  }
  return null;
}

function reLinesOfPair(results, parentResults) {
  const re = results.filter((line) => line.agent === PROFILE_RE);
  const parentRe = parentResults.filter((line) => line.agent === PROFILE_RE);
  if (re.length === 0 || parentRe.length === 0) return [];
  return [...re, ...parentRe];
}

export function reDigestError(results, parentResults) {
  const lines = reLinesOfPair(results, parentResults);
  return distinctCount(lines, DIGEST_KEY) > 1 ? DIGEST_KEY : null;
}

export function reKeysDiffer(results, parentResults) {
  const lines = reLinesOfPair(results, parentResults);
  return RE_COMPARE_KEYS.some((key) => distinctCount(lines, key) > 1);
}

export function oneChangeError(engineRoot, parentCommit, newCommit) {
  if (parentCommit === newCommit) return null;
  const result = gitOutput(engineRoot, [
    "diff",
    "--name-only",
    parentCommit,
    newCommit,
  ]);
  if (result === null) return "git diff failed for the engine commits";
  const changed = result.split("\n").filter(Boolean);
  const extra = changed.filter((p) => !ONE_CHANGE_FILES.includes(p));
  if (extra.length > 0) return `git diff --name-only names ${extra[0]}`;
  return null;
}

export function runActionForExit(exitCode, stderrText) {
  if (stderrText.includes(PROMPT_TEXT_PATH_CODE)) return ACTION_STOP;
  if (exitCode === EXIT_RETRYABLE) return ACTION_RETRY;
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

function partText(part) {
  if (part.type === TEXT_PART) return part.text;
  if (part.type === TOOL_CALL_PART)
    return `Tool call ${part.name}: ${JSON.stringify(part.arguments)}`;
  return null;
}

function messageText(message) {
  const { role, content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.map(partText).filter((text) => text !== null);
  if (role === TOOL_RESULT_ROLE)
    return texts.join("").slice(0, TRANSCRIPT_TOOL_RESULT_LIMIT);
  return texts.join("\n");
}

function transcriptSection(raw) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return [];
  }
  if (entry?.type !== TRANSCRIPT_ENTRY_TYPE || !isObject(entry.message))
    return [];
  const { id, message } = entry;
  return [
    `## ${id}`,
    "",
    `Role: ${message.role}`,
    "",
    messageText(message),
    "",
  ];
}

export function writeTranscript(sessionPath, transcriptPath) {
  const text = existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : "";
  const lines = text.split("\n").filter(Boolean).flatMap(transcriptSection);
  writeFileSync(transcriptPath, lines.join("\n"), { mode: FILE_MODE });
}

function findingValid(finding) {
  if (!isObject(finding) || Object.keys(finding).length !== 3) return false;
  const { aspect, evidence, severity } = finding;
  if (!DIAGNOSIS_ASPECTS.includes(aspect)) return false;
  if (typeof evidence !== "string") return false;
  if (evidence.length < 1 || evidence.length > EVIDENCE_MAX) return false;
  return DIAGNOSIS_SEVERITIES.includes(severity);
}

export function parseDiagnosis(text, end) {
  const invalid = { valid: false, findings: [] };
  if (end !== END_COMPLETED || typeof text !== "string") return invalid;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid;
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1) return invalid;
  const { findings } = parsed;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS)
    return invalid;
  if (!findings.every(findingValid)) return invalid;
  return { valid: true, findings };
}

export function runAgentArgsJudge(
  run,
  judgeWorkspace,
  judgeSessionPath,
  outputPath,
) {
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
  args.push("--output", outputPath);
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

function runCaseScript(output, args, { cwd, limitMs }) {
  const result = spawnSync("sh", args, {
    cwd,
    detached: true,
    timeout: limitMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", output, output],
  });
  if (result.pid > 0) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (e) {
      if (!EMPTY_GROUP_CODES.includes(e.code)) throw e;
    }
  }
  return result;
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

function readStart(fd, limit) {
  const buffer = Buffer.alloc(Math.min(fstatSync(fd).size, limit));
  const size = readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.toString("utf8", 0, size);
}

function runCheckMode(grade, mode) {
  const limitMs = grade.limitMs ?? SCRIPT_LIMIT_MS;
  const outPath = `${grade.checkTxtPath}.${mode}.tmp`;
  const fd = openSync(outPath, "w+", FILE_MODE);
  let result;
  let text;
  try {
    result = runCaseScript(
      fd,
      [join(grade.caseFolder, "check", "check.sh"), grade.gradingDir, mode],
      { cwd: grade.gradingDir, limitMs },
    );
    text = readStart(fd, CHECK_OUTPUT_LIMIT);
  } finally {
    closeSync(fd);
    rmSync(outPath, { force: true });
  }
  const timedOut = result.error?.code === "ETIMEDOUT";
  const exit = timedOut ? "timeout" : (result.status ?? EXIT_STOP);
  appendCheckText(grade.checkTxtPath, { mode, exit, text });
  return exit === EXIT_OK;
}

function runSetup(caseFolder, cwd, limitMs) {
  const result = runCaseScript("ignore", [join(caseFolder, "setup.sh")], {
    cwd,
    limitMs: limitMs ?? SCRIPT_LIMIT_MS,
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
  if (!runSetup(caseFolder, gradingDir, grade.limitMs))
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
  args.push("--output", join(run.runDir, "result.jsonl"));
  args.push("--prompt", join(run.caseFolder, "task.md"));
  return args;
}

function escSbpl(p) {
  return p.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ancestorsUnderRoots(path, roots) {
  const result = [];
  let cur = dirname(path);
  while (roots.some((r) => cur === r || cur.startsWith(r + "/"))) {
    result.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return result;
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    if (!EMPTY_GROUP_CODES.includes(e.code)) throw e;
  }
}

export function spawnToPromise(cmd, args, stderrFd, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: null });
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "ignore", stderrFd],
        detached: true,
      });
    } catch {
      resolve({ status: null });
      return;
    }
    const onAbort = () => {
      if (child.pid !== undefined) killGroup(child.pid);
    };
    signal?.addEventListener("abort", onAbort);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ status: code });
    });
    child.once("error", () => resolve({ status: null }));
  });
}

function createAuthGate() {
  let readers = 0;
  let writing = false;
  let writerWaiting = 0;
  const readersDone = [];
  const writerDone = [];
  const readersBlocked = [];
  return {
    async enterCall() {
      while (writing || writerWaiting > 0) {
        await new Promise((resolve) => readersBlocked.push(resolve));
      }
      readers++;
    },
    leaveCall() {
      readers--;
      if (readers === 0) {
        for (const resolve of readersDone.splice(0)) resolve();
      }
    },
    async exclusive(fn) {
      writerWaiting++;
      while (writing) {
        await new Promise((resolve) => writerDone.push(resolve));
      }
      writerWaiting--;
      writing = true;
      while (readers > 0) {
        await new Promise((resolve) => readersDone.push(resolve));
      }
      try {
        await fn();
      } finally {
        writing = false;
        const nextWriters = writerDone.splice(0);
        if (nextWriters.length > 0) {
          for (const resolve of nextWriters) resolve();
        } else {
          for (const resolve of readersBlocked.splice(0)) resolve();
        }
      }
    },
  };
}

const NO_OP_GATE = {
  enterCall: () => Promise.resolve(),
  leaveCall: () => {},
  exclusive: (fn) => fn(),
};

export function osDenyWrapper(
  setRealPath,
  resultsBaseRealPath,
  workRootRealPath,
) {
  const denied = [setRealPath, resultsBaseRealPath, workRootRealPath];
  const plat = platform();
  const readScript = (file) =>
    `try{require('fs').readFileSync(${JSON.stringify(file)});process.exit(0);}catch{process.exit(1);}`;
  const readOutsideScript = `require('fs').readFileSync('/dev/null');`;
  if (plat === "darwin") {
    const check = spawnSync(
      "sandbox-exec",
      ["-p", "(version 1)(allow default)", "true"],
      { stdio: "ignore" },
    );
    if (check.error) return null;
    const denyRules = denied
      .map((p) => `(deny file-read* file-write* (subpath "${escSbpl(p)}"))`)
      .join("");
    function buildPolicy(allowed) {
      const metaPaths = [
        ...new Set([
          ...denied,
          ...allowed.flatMap((p) => ancestorsUnderRoots(p, denied)),
        ]),
      ];
      const metaRules = metaPaths
        .map((p) => `(allow file-read-metadata (literal "${escSbpl(p)}"))`)
        .join("");
      const allowRules = allowed
        .map((p) => `(allow file-read* file-write* (subpath "${escSbpl(p)}"))`)
        .join("");
      return `(version 1)(allow default)${denyRules}${metaRules}${allowRules}`;
    }
    return {
      run(nodeExec, bin, cmdArgs, stderrFd, allowed, signal) {
        return spawnToPromise(
          "sandbox-exec",
          ["-p", buildPolicy(allowed), nodeExec, bin, ...cmdArgs],
          stderrFd,
          signal,
        );
      },
      runScript(nodeExec, scriptText) {
        return spawnSync(
          "sandbox-exec",
          ["-p", buildPolicy([]), nodeExec, "-e", scriptText],
          { stdio: "ignore" },
        );
      },
      probe(nodeExec, setFile) {
        const denySet = this.runScript(nodeExec, readScript(setFile));
        if (denySet.status === 0)
          return "sandbox: set file read was not denied";
        const probeFiles = [];
        try {
          for (const root of [resultsBaseRealPath, workRootRealPath]) {
            const f = join(root, `.eval-probe-${randomName()}`);
            writeFileSync(f, "x", { mode: FILE_MODE });
            probeFiles.push(f);
          }
          for (const [i, root] of [
            resultsBaseRealPath,
            workRootRealPath,
          ].entries()) {
            const deny = this.runScript(nodeExec, readScript(probeFiles[i]));
            if (deny.status === 0)
              return `sandbox: ${root} file read was not denied`;
          }
          const allow = this.runScript(nodeExec, readOutsideScript);
          if (allow.status !== 0)
            return "sandbox: file read outside the denied roots was denied";
          return null;
        } finally {
          for (const f of probeFiles) rmSync(f, { force: true });
        }
      },
    };
  }
  if (plat === "linux") {
    const check = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
    if (check.error) return null;
    const bwrapDeny = [
      "--dev-bind",
      "/",
      "/",
      "--tmpfs",
      setRealPath,
      "--tmpfs",
      resultsBaseRealPath,
      "--tmpfs",
      workRootRealPath,
    ];
    function bwrapArgs(allowed) {
      return [
        ...bwrapDeny,
        ...allowed.flatMap((p) => ["--bind", p, p]),
        "--die-with-parent",
      ];
    }
    return {
      run(nodeExec, bin, cmdArgs, stderrFd, allowed, signal) {
        return spawnToPromise(
          "bwrap",
          [...bwrapArgs(allowed), nodeExec, bin, ...cmdArgs],
          stderrFd,
          signal,
        );
      },
      runScript(nodeExec, scriptText) {
        return spawnSync(
          "bwrap",
          [...bwrapArgs([]), nodeExec, "-e", scriptText],
          {
            stdio: "ignore",
          },
        );
      },
      probe(nodeExec, setFile) {
        const denySet = this.runScript(nodeExec, readScript(setFile));
        if (denySet.status === 0) return "bwrap: set file read was not denied";
        const probeFiles = [];
        try {
          for (const root of [resultsBaseRealPath, workRootRealPath]) {
            const f = join(root, `.eval-probe-${randomName()}`);
            writeFileSync(f, "x", { mode: FILE_MODE });
            probeFiles.push(f);
          }
          for (const [i, root] of [
            resultsBaseRealPath,
            workRootRealPath,
          ].entries()) {
            const deny = this.runScript(nodeExec, readScript(probeFiles[i]));
            if (deny.status === 0)
              return `bwrap: ${root} file read was not denied`;
          }
          const allow = this.runScript(nodeExec, readOutsideScript);
          if (allow.status !== 0)
            return "bwrap: file read outside the denied roots was denied";
          return null;
        } finally {
          for (const f of probeFiles) rmSync(f, { force: true });
        }
      },
    };
  }
  return null;
}

export function copyPromptArgs(args, tmpDir) {
  const copied = [...args];
  let counter = 0;
  for (let i = 0; i < copied.length - 1; i++) {
    if (copied[i] === "--prompt" || copied[i] === "--system-prompt") {
      const src = copied[i + 1];
      const dest = join(tmpDir, `${counter++}-${basename(src)}`);
      writeFileSync(dest, readFileSync(src), { mode: FILE_MODE, flag: "wx" });
      copied[i + 1] = dest;
    }
  }
  return copied;
}

async function runAgentProcess(
  args,
  stderrPath,
  wrapper,
  allowedPaths,
  signal,
) {
  const fd = openSync(stderrPath, "w", FILE_MODE);
  try {
    const tmpDir = mkdtempSync(join(tmpdir(), "kanthord-eval-"));
    try {
      const copiedArgs = copyPromptArgs(args, tmpDir);
      const result = await wrapper.run(
        process.execPath,
        BIN,
        copiedArgs,
        fd,
        allowedPaths,
        signal,
      );
      return result.status ?? EXIT_STOP;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    closeSync(fd);
  }
}

function makeRoot(workBaseDir) {
  const root = join(workBaseDir, randomName());
  mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
  return root;
}

function atPathBoundary(text, idx) {
  if (idx === 0) return true;
  const before = text[idx - 1];
  return PATH_BOUNDARY_CHARS.includes(before) || before.trim() === "";
}

function holdsFileName(text, name) {
  let idx = text.indexOf(name);
  while (idx !== -1) {
    if (atPathBoundary(text, idx)) return true;
    idx = text.indexOf(name, idx + 1);
  }
  return false;
}

function namesProtectedPath(text, pathStrings) {
  if (pathStrings.some((part) => text.includes(part))) return true;
  return [...PROTECTED_FILE_NAMES, PROTECTED_FILE_PREFIX].some((name) =>
    holdsFileName(text, name),
  );
}

function stringsOf(value) {
  if (typeof value === "string") return [value];
  if (!isObject(value) && !Array.isArray(value)) return [];
  const entries = Array.isArray(value) ? value : Object.entries(value).flat();
  return entries.flatMap(stringsOf);
}

function lineStrings(line) {
  try {
    return stringsOf(JSON.parse(line));
  } catch {
    return [];
  }
}

export function hasProtectedPath(sessionText, pathStrings) {
  if (namesProtectedPath(sessionText, pathStrings)) return true;
  return sessionText
    .split("\n")
    .flatMap(lineStrings)
    .some((text) => namesProtectedPath(text, pathStrings));
}

export function protectedPathStrings(evalSetDir, resultsDir, caseFolder) {
  return [evalSetDir, resultsDir, caseFolder, ...PROTECTED_PATH_PARTS];
}

async function concurrentMap(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function linkEscapes(relPath, target) {
  if (isAbsolute(target)) return true;
  const segments = target.split(sep);
  let up = 0;
  while (segments[up] === "..") up++;
  if (segments.slice(up).includes("..")) return true;
  return up > relPath.split(sep).length - 3;
}

function byRelPath(a, b) {
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

function linkEntry(relPath, absPath, found) {
  let target;
  try {
    target = readlinkSync(absPath);
  } catch {
    found.refusals.push({ relPath, reason: "no read" });
    return;
  }
  if (MANIFEST_REFUSED_TEXT.test(target))
    found.refusals.push({
      relPath,
      reason: "the symlink target holds a tab or a newline",
    });
  else if (linkEscapes(relPath, target))
    found.refusals.push({
      relPath,
      reason: "symlink points outside its folder",
    });
  else
    found.entries.push({
      type: MANIFEST_TYPE_LINK,
      content: target,
      mode: MANIFEST_MODE_NONE,
      relPath,
    });
}

function walkShared(relDir, absDir, found) {
  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    found.refusals.push({ relPath: relDir, reason: "no read" });
    return;
  }
  for (const dirent of dirents) {
    const relPath = join(relDir, dirent.name);
    const absPath = join(absDir, dirent.name);
    if (MANIFEST_REFUSED_TEXT.test(dirent.name)) {
      found.refusals.push({
        relPath,
        reason: "the name holds a tab or a newline",
      });
    } else if (dirent.isSymbolicLink()) {
      linkEntry(relPath, absPath, found);
    } else if (dirent.isDirectory()) {
      found.entries.push({
        type: MANIFEST_TYPE_DIR,
        content: MANIFEST_MODE_NONE,
        mode: MANIFEST_MODE_NONE,
        relPath,
      });
      walkShared(relPath, absPath, found);
    } else if (dirent.isFile()) {
      found.files.push({ relPath, absPath });
    } else {
      found.refusals.push({
        relPath,
        reason: "no regular file, directory or symlink",
      });
    }
  }
}

async function fileEntry({ relPath, absPath }) {
  let handle;
  try {
    handle = await open(
      absPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      return { refusal: { relPath, reason: "no regular file" } };
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return {
      entry: {
        type: MANIFEST_TYPE_FILE,
        content: hash.digest("hex"),
        mode: stat.mode & 0o111 ? MANIFEST_MODE_EXEC : MANIFEST_MODE_NONE,
        relPath,
      },
    };
  } catch {
    return { refusal: { relPath, reason: "no read" } };
  } finally {
    await handle?.close();
  }
}

async function scanShared(evalSetDir) {
  const found = { entries: [], files: [], refusals: [] };
  const sharedDir = join(evalSetDir, SHARED_DIR);
  const stat = lstatSync(sharedDir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory())
    found.refusals.push({ relPath: SHARED_DIR, reason: "no directory" });
  else if (stat) walkShared(SHARED_DIR, sharedDir, found);
  const results = await concurrentMap(
    found.files,
    MANIFEST_CONCURRENCY,
    fileEntry,
  );
  for (const result of results) {
    if (result.entry) found.entries.push(result.entry);
    else found.refusals.push(result.refusal);
  }
  found.entries.sort(byRelPath);
  found.refusals.sort(byRelPath);
  return { entries: found.entries, refusal: found.refusals[0] ?? null };
}

function manifestLine({ type, content, mode, relPath }) {
  return `${type}\t${content}\t${mode}\t${relPath}\n`;
}

function readManifest(evalSetDir) {
  const path = manifestPath(evalSetDir);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (text === "") return [];
  if (!text.endsWith("\n")) return null;
  const entries = [];
  for (const line of text.slice(0, -1).split("\n")) {
    if (!MANIFEST_LINE.test(line)) return null;
    const [type, content, mode, relPath] = line.split("\t");
    if (entries.length > 0 && entries.at(-1).relPath >= relPath) return null;
    entries.push({ type, content, mode, relPath });
  }
  return entries;
}

function firstManifestDifference(expected, actual) {
  let ei = 0;
  let ai = 0;
  while (ei < expected.length && ai < actual.length) {
    const e = expected[ei];
    const a = actual[ai];
    if (e.relPath < a.relPath) return e.relPath;
    if (e.relPath > a.relPath) return a.relPath;
    if (e.type !== a.type || e.content !== a.content || e.mode !== a.mode)
      return e.relPath;
    ei++;
    ai++;
  }
  if (ei < expected.length) return expected[ei].relPath;
  if (ai < actual.length) return actual[ai].relPath;
  return null;
}

export function manifestPath(evalSetDir) {
  return join(evalSetDir, MANIFEST_FILE);
}

export async function writeManifest(evalSetDir) {
  if (!lstatSync(evalSetDir, { throwIfNoEntry: false })?.isDirectory())
    return `manifest: no evaluation set ${evalSetDir}`;
  const { entries, refusal } = await scanShared(evalSetDir);
  if (refusal) return `manifest: ${refusal.relPath}: ${refusal.reason}`;
  const path = manifestPath(evalSetDir);
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, entries.map(manifestLine).join(""), {
    mode: FILE_MODE,
    flag: "wx",
  });
  renameSync(temporary, path);
  return null;
}

export async function checkManifestDiff(evalSetDir) {
  const expected = readManifest(evalSetDir);
  if (expected === null) return MANIFEST_FILE;
  const { entries, refusal } = await scanShared(evalSetDir);
  const difference = firstManifestDifference(expected, entries);
  const refused = refusal?.relPath ?? null;
  if (difference === null || refused === null) return difference ?? refused;
  return difference < refused ? difference : refused;
}

function setTreeOutput(evalSetDir, setCommit) {
  const result = spawnSync("git", ["ls-tree", "-r", "-z", setCommit], {
    cwd: evalSetDir,
    env: isolatedGitEnvironment(process.env),
    encoding: "utf8",
    maxBuffer: CHECK_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

function hashObjectFiles(evalSetDir, absPaths) {
  if (absPaths.length === 0) return [];
  const result = spawnSync(
    "git",
    ["hash-object", "--no-filters", "--stdin-paths"],
    {
      cwd: evalSetDir,
      env: isolatedGitEnvironment(process.env),
      encoding: "utf8",
      input: absPaths.join("\n") + "\n",
      maxBuffer: CHECK_OUTPUT_LIMIT,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) return null;
  const hashes = result.stdout.split("\n").filter(Boolean);
  return hashes.length === absPaths.length ? hashes : null;
}

function hashLinkBlob(evalSetDir, target) {
  const result = spawnSync("git", ["hash-object", "--stdin"], {
    cwd: evalSetDir,
    env: isolatedGitEnvironment(process.env),
    encoding: "utf8",
    input: target,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function setChangeFromTree(evalSetDir, setCommit) {
  const treeRaw = setTreeOutput(evalSetDir, setCommit);
  if (treeRaw === null) return true;
  const expected = new Map();
  if (treeRaw !== "") {
    for (const entry of treeRaw.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      if (tab === -1) return true;
      const path = entry.slice(tab + 1);
      const fields = entry.slice(0, tab).split(" ");
      if (fields.length !== 3) return true;
      expected.set(path, { mode: fields[0], blob: fields[2] });
    }
  }
  const files = [];
  const links = [];
  function walk(relDir, absDir) {
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of dirents) {
      if (!relDir && entry.name === ".git") continue;
      if (!relDir && entry.name === "config.json" && entry.isFile()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ relPath, absPath });
      } else if (entry.isFile()) {
        files.push({ relPath, absPath });
      } else if (entry.isDirectory()) {
        const parentParts = relDir.split("/");
        if (
          parentParts.length === 2 &&
          parentParts[0] === "shared" &&
          entry.name === "node_modules"
        )
          continue;
        if (!walk(relPath, absPath)) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  if (!walk("", evalSetDir)) return true;
  const hashes = hashObjectFiles(
    evalSetDir,
    files.map((f) => f.absPath),
  );
  if (hashes === null) return true;
  const actual = new Map();
  for (let i = 0; i < files.length; i++) {
    let st;
    try {
      st = lstatSync(files[i].absPath);
    } catch {
      return true;
    }
    const mode = st.mode & 0o100 ? SET_EXEC_MODE : SET_PLAIN_MODE;
    actual.set(files[i].relPath, { mode, blob: hashes[i] });
  }
  for (const { relPath, absPath } of links) {
    let target;
    try {
      target = readlinkSync(absPath);
    } catch {
      return true;
    }
    const hash = hashLinkBlob(evalSetDir, target);
    if (hash === null) return true;
    actual.set(relPath, { mode: SET_SYMLINK_MODE, blob: hash });
  }
  if (expected.size !== actual.size) return true;
  for (const [path, e] of expected) {
    const a = actual.get(path);
    if (!a || a.mode !== e.mode || a.blob !== e.blob) return true;
  }
  return false;
}

async function checkSetChangeBreach(evalSetDir, setCommit) {
  const head = gitOutput(evalSetDir, ["rev-parse", "HEAD"]);
  if (head !== setCommit) return true;
  if (setChangeFromTree(evalSetDir, setCommit)) return true;
  return (await checkManifestDiff(evalSetDir)) !== null;
}

function sessionText(sessionPath) {
  return existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : "";
}

function breachStop(run, breach) {
  appendJsonLine(run.checksPath, breachCheckLine(run, breach));
  return { stop: STOP_BREACH, breach };
}

function credentialStop(run, count) {
  process.stdout.write(`evaluation: breach credential, count ${count}\n`);
  return breachStop(run, BREACH_CREDENTIAL);
}

async function refreshForCall(run, deps, call) {
  const provider = parseModelSelection(call.model).provider;
  const validity = parseWallMs(call.wall) + REFRESH_MARGIN_MS;
  try {
    await deps.refresh(run.authPath, provider, validity);
    return true;
  } catch {
    return false;
  }
}

async function guardedAgentCall(run, deps, call) {
  if (deps.signal?.aborted) return { stop: "killed" };
  if (!(await refreshForCall(run, deps, call)))
    return { stop: "the credential refresh failed" };
  const gate = deps.gate ?? NO_OP_GATE;
  await gate.enterCall();
  let exit;
  try {
    const refreshed = captureAuthState(run.authPath);
    if (refreshedAuthBreach(refreshed, run.authStart))
      return breachStop(run, BREACH_AUTH_FILE);
    for (const value of extractCredentialValues(run.authPath))
      run.credValues.add(value);
    let inputCount = 0;
    for (const path of call.inputPaths)
      inputCount += countCredentialInFile(path, run.credValues);
    if (inputCount > 0) return credentialStop(run, inputCount);
    if (deps.signal?.aborted) return { stop: "killed" };
    mkdirSync(run.runDir, { recursive: true, mode: DIRECTORY_MODE });
    exit = await deps.runAgent(
      call.args,
      call.stderrPath,
      call.allowedPaths,
      deps.signal,
    );
    if (deps.signal?.aborted) return { stop: "killed" };
    if (existsSync(call.outputPath)) {
      const content = readFileSync(call.outputPath);
      if (content.length > 0)
        appendFileSync(run.resultsPath, content, { mode: FILE_MODE });
    }
    const count = countCredentialInFile(call.sessionPath, run.credValues);
    if (count > 0) return credentialStop(run, count);
    if (checkAuthFileBreach(run.authPath, refreshed))
      return breachStop(run, BREACH_AUTH_FILE);
  } finally {
    gate.leaveCall();
  }
  if (call.protectedPathSearch) {
    const pathStrings = protectedPathStrings(
      run.evalSetDir,
      dirname(run.resultsPath),
      run.caseFolder,
    );
    if (hasProtectedPath(sessionText(call.sessionPath), pathStrings))
      return breachStop(run, BREACH_PROTECTED_PATH);
  }
  if (await checkSetChangeBreach(run.evalSetDir, run.setCommit))
    return breachStop(run, BREACH_SET_CHANGE);
  const stderrText = readFileSync(call.stderrPath, "latin1");
  const action = runActionForExit(exit, stderrText);
  if (action === ACTION_STOP) return { stop: `${call.label} exit ${exit}` };
  if (action === ACTION_RETRY) return { stop: null, retry: true };
  return { stop: null };
}

function nextJudgeAttempt(runDir) {
  let n = 1;
  while (
    existsSync(join(runDir, `judge-${n}.jsonl`)) ||
    existsSync(join(runDir, `judge-${n}-stderr.txt`))
  )
    n++;
  return n;
}

export function nextRunAttempt(resultsDir, caseId, repeat) {
  let n = 1;
  while (existsSync(join(resultsDir, caseId, `${repeat}-${n}`))) n++;
  return n;
}

function resultEnd(run) {
  const line = readJsonLines(run.resultsPath).findLast(
    (entry) => entry.session === run.sessionPath,
  );
  return line?.end ?? END_ABSENT;
}

function gradeDiff(run, gradingRoot) {
  return gradeRun({
    caseFolder: run.caseFolder,
    caseJson: run.caseJson,
    gradingDir: join(gradingRoot, GRADING_NAME),
    diffPath: join(run.runDir, "diff.patch"),
    checkTxtPath: join(run.runDir, "check.txt"),
    limitMs: run.limitMs,
  });
}

function gradeWorkspace(run, session) {
  const diffPath = join(run.runDir, "diff.patch");
  const diffOptions = { savedConfig: session.savedConfig, diffPath };
  let aspects = { a1: false, a2: false, a3: false, a4: false };
  if (diffSteps(session.workspace, run.caseJson.commit, diffOptions)) {
    const diffCount = removeRunFilesOnCredential(run.runDir, run.credValues);
    if (diffCount > 0) return credentialStop(run, diffCount);
    const graded = gradeDiff(run, session.gradingRoot);
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

function writeJudgeWorkspace(run, judgeWorkspace) {
  mkdirSync(judgeWorkspace, { mode: DIRECTORY_MODE });
  writeTranscript(run.sessionPath, join(judgeWorkspace, "transcript.md"));
  for (const name of ["diff.patch", "check.txt"]) {
    const source = join(run.runDir, name);
    if (existsSync(source)) copyFileSync(source, join(judgeWorkspace, name));
  }
  const checkLine = readJsonLines(run.checksPath).findLast(
    (line) => line.session === run.sessionPath,
  );
  writeFileSync(
    join(judgeWorkspace, "check.json"),
    `${JSON.stringify(checkLine)}\n`,
    { mode: FILE_MODE },
  );
  copyFileSync(
    join(run.caseFolder, "task.md"),
    join(judgeWorkspace, "task.md"),
  );
  if (run.stage === BINDING_STAGE) {
    const name = `${run.caseJson.kind}.md`;
    copyFileSync(
      join(run.evalSetDir, "binding", name),
      join(judgeWorkspace, name),
    );
  }
  return readdirSync(judgeWorkspace).map((name) => join(judgeWorkspace, name));
}

function startGateOpen(run, usd, inFlightReserveSum = 0) {
  const sum = baseCostSum(run.resultsPath, run.ratio.r, run.judgeRatio.r);
  const reserve = parseUsdCents(usd) / CENTS_PER_DOLLAR;
  return checkStartGate(sum + inFlightReserveSum, reserve, run.config.cap_usd);
}

async function runDiagnosis(run, gradingRoot, deps) {
  if (!startGateOpen(run, run.config.judge_usd, deps.inFlightReserveSum))
    return { stop: STOP_CAP };
  const judgeWorkspace = join(gradingRoot, JUDGE_DIR);
  const inputPaths = writeJudgeWorkspace(run, judgeWorkspace);
  let exit75Count = 0;
  let judgeSessionPath;
  for (;;) {
    const attempt = nextJudgeAttempt(run.runDir);
    judgeSessionPath = join(run.runDir, `judge-${attempt}.jsonl`);
    const judgeOutputPath = join(run.runDir, `judge-${attempt}-result.jsonl`);
    const called = await guardedAgentCall(run, deps, {
      label: "judge",
      model: run.config.judge_model,
      wall: JUDGE_WALL,
      args: runAgentArgsJudge(
        run,
        judgeWorkspace,
        judgeSessionPath,
        judgeOutputPath,
      ),
      inputPaths,
      sessionPath: judgeSessionPath,
      stderrPath: join(run.runDir, `judge-${attempt}-stderr.txt`),
      outputPath: judgeOutputPath,
      allowedPaths: [judgeWorkspace, run.runDir],
      protectedPathSearch: false,
    });
    if (called.stop) return called;
    if (!called.retry) break;
    exit75Count++;
    if (exit75Count >= MAX_RETRYABLE) return { stop: "third exit 75" };
    if (!startGateOpen(run, run.config.judge_usd, deps.inFlightReserveSum))
      return { stop: STOP_CAP };
  }
  const resultLine = readJsonLines(run.resultsPath).findLast(
    (line) => line.agent === PROFILE_RE && line.session === judgeSessionPath,
  );
  appendJsonLine(run.diagnosesPath, {
    session: judgeSessionPath,
    ...parseDiagnosis(resultLine?.text, resultLine?.end),
  });
  return { stop: null };
}

async function evaluateInRoots(run, deps, roots) {
  let currentRun = run;
  let exit75Count = 0;
  let savedConfig;
  for (;;) {
    const workspace = join(roots[roots.length - 1], WORKSPACE_NAME);
    const bundle = join(run.caseFolder, "repo.bundle");
    savedConfig = cloneSteps(bundle, workspace, run.caseJson.commit);
    if (savedConfig === null) return { stop: "the workspace clone failed" };
    if (!runSetup(run.caseFolder, workspace, run.limitMs))
      return { stop: "setup.sh failed in the workspace" };
    const sweOutputPath = join(currentRun.runDir, "result.jsonl");
    const called = await guardedAgentCall(currentRun, deps, {
      label: "run agent",
      model: run.config.model,
      wall: run.caseJson.wall,
      args: runAgentArgs(currentRun, workspace),
      inputPaths: [],
      sessionPath: currentRun.sessionPath,
      stderrPath: join(currentRun.runDir, "stderr.txt"),
      outputPath: sweOutputPath,
      allowedPaths: [workspace, currentRun.runDir],
      protectedPathSearch: true,
    });
    if (called.stop) return called;
    if (!called.retry) break;
    exit75Count++;
    if (exit75Count >= MAX_RETRYABLE) return { stop: "third exit 75" };
    if (!startGateOpen(run, run.caseJson.usd, deps.inFlightReserveSum))
      return { stop: STOP_CAP };
    const resultsDir = dirname(run.checksPath);
    const nextAttempt = nextRunAttempt(resultsDir, run.caseId, run.repeat);
    const nextRunDir = join(
      resultsDir,
      run.caseId,
      `${run.repeat}-${nextAttempt}`,
    );
    currentRun = {
      ...currentRun,
      runDir: nextRunDir,
      sessionPath: join(nextRunDir, "session.jsonl"),
    };
    roots.push(makeRoot(run.workBaseDir));
  }
  const workspace = join(roots[roots.length - 1], WORKSPACE_NAME);
  const gradingRoot = makeRoot(run.workBaseDir);
  roots.push(gradingRoot);
  const graded = gradeWorkspace(currentRun, {
    workspace,
    savedConfig,
    gradingRoot,
  });
  if (graded.stop || run.set !== SET_DEV) return graded;
  return runDiagnosis(currentRun, gradingRoot, deps);
}

export async function evaluateRun(run, deps) {
  const roots = [makeRoot(run.workBaseDir)];
  try {
    if (run.diagnosisOnly) return await runDiagnosis(run, roots[0], deps);
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
        jobs: { type: "string" },
        parent: { type: "string" },
        aspect: { type: "string" },
        hypothesis: { type: "string" },
        replicate: { type: "string" },
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
  let jobs = DEFAULT_JOBS;
  if (values.jobs !== undefined) {
    const parsed = Number(values.jobs);
    if (!Number.isInteger(parsed) || parsed < MIN_JOBS || parsed > MAX_JOBS)
      return {
        error: `--jobs is an integer from ${MIN_JOBS} to ${MAX_JOBS}`,
        usageError: true,
      };
    jobs = parsed;
  }
  const hasParent = values.parent !== undefined;
  const hasReplicate = values.replicate !== undefined;
  if (hasParent && values.set !== SET_DEV)
    return { error: "--parent requires --set dev" };
  if (hasParent && values.aspect === undefined)
    return { error: "--parent requires --aspect" };
  if (hasParent && values.hypothesis === undefined)
    return { error: "--parent requires --hypothesis" };
  if (!hasParent && values.aspect !== undefined)
    return { error: "--aspect requires --parent" };
  if (!hasParent && values.hypothesis !== undefined)
    return { error: "--hypothesis requires --parent" };
  if (
    hasParent &&
    values.aspect !== undefined &&
    !ASPECT_VALUES.includes(values.aspect)
  )
    return { error: "--aspect is A1 to A7" };
  if (
    hasParent &&
    values.hypothesis !== undefined &&
    (values.hypothesis.length < 1 ||
      values.hypothesis.length > HYPOTHESIS_MAX_LENGTH)
  )
    return { error: "--hypothesis is 1 to 500 characters" };
  if (hasReplicate && hasParent)
    return { error: "--replicate requires no --parent" };
  if (hasReplicate && values.set !== SET_DEV)
    return { error: "--replicate requires --set dev" };
  if (hasReplicate && (!values.replicate || !EVAL_ID_RE.test(values.replicate)))
    return { error: "--replicate holds letters, digits, - and _" };
  if (hasParent && (!values.parent || !EVAL_ID_RE.test(values.parent)))
    return { error: "--parent holds letters, digits, - and _" };
  return {
    evalId: values.evaluation,
    stage: Number(values.stage),
    set: values.set,
    jobs,
    parent: values.parent ?? null,
    aspect: values.aspect ?? null,
    hypothesis: values.hypothesis ?? null,
    replicate: values.replicate ?? null,
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
  if ((existing.jobs ?? 1) !== plan.jobs)
    return "--jobs differs from iteration";
  if ((existing.parent ?? null) !== (plan.parent ?? null))
    return "--parent differs from iteration";
  if ((existing.replicate ?? null) !== (plan.replicate ?? null))
    return "--replicate differs from iteration";
  if ((existing.aspect ?? null) !== (plan.aspect ?? null))
    return "--aspect differs from iteration";
  if ((existing.hypothesis ?? null) !== (plan.hypothesis ?? null))
    return "--hypothesis differs from iteration";
  return null;
}

function newIteration(plan) {
  return {
    stage: plan.stage,
    set: plan.set,
    set_commit: plan.setCommit,
    engine_commit: plan.engineCommit,
    repeats: plan.config.repeats,
    jobs: plan.jobs,
    gate_share: plan.set === SET_HELD_OUT ? plan.config.gate_share : null,
    parent: plan.parent ?? null,
    replicate: plan.replicate ?? null,
    aspect: plan.aspect ?? null,
    hypothesis: plan.hypothesis ?? null,
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
  const manifestDiff = await checkManifestDiff(evalSetDir);
  if (manifestDiff !== null)
    return {
      error: `manifest: ${manifestDiff}: tree differs from manifest`,
    };
  const cases = readCases(evalSetDir, options.set);
  if (cases.error) return cases;
  const authStart = captureAuthState(start.authPath);
  if (authStart === null) return { error: "auth.json is no regular file" };
  const resultsBaseDir = join(dirs.state, "evaluation", "runs");
  if (options.parent !== null) {
    const parentIteration = readJsonFile(
      join(resultsBaseDir, options.parent, "iteration.json"),
    );
    if (!isObject(parentIteration))
      return { error: `--parent ${options.parent}: no iteration.json` };
    if (parentIteration.stage !== options.stage)
      return { error: `--parent ${options.parent}: stage differs` };
    if (parentIteration.set !== SET_DEV)
      return { error: `--parent ${options.parent}: set is not dev` };
  }
  if (options.replicate !== null) {
    const replicateIteration = readJsonFile(
      join(resultsBaseDir, options.replicate, "iteration.json"),
    );
    if (!isObject(replicateIteration))
      return { error: `--replicate ${options.replicate}: no iteration.json` };
    if (replicateIteration.stage !== options.stage)
      return { error: `--replicate ${options.replicate}: stage differs` };
    if (replicateIteration.set !== SET_DEV)
      return { error: `--replicate ${options.replicate}: set is not dev` };
  }
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
    const r = line.agent === PROFILE_RE ? judgeR : sweR;
    sum += computeBaseCost(line.list_price_usd ?? 0, r);
  }
  return sum;
}

function planRun(plan, entry, repeat, runDirOverride) {
  const runDir =
    runDirOverride ??
    join(
      plan.resultsDir,
      entry.id,
      `${repeat}-${nextRunAttempt(plan.resultsDir, entry.id, repeat)}`,
    );
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
    setCommit: plan.setCommit,
    authPath: plan.authPath,
    authStart: plan.authStart,
    credValues: plan.credValues,
    config: plan.config,
    ratio: plan.ratio,
    judgeRatio: plan.judgeRatio,
    stage: plan.stage,
    set: plan.set,
    limitMs: plan.limitMs,
  };
}

function planRunDiagnosisOnly(plan, entry, repeat, checkLine) {
  return {
    ...planRun(plan, entry, repeat, dirname(checkLine.session)),
    diagnosisOnly: true,
  };
}

function pendingRuns(plan) {
  const checks = readJsonLines(join(plan.resultsDir, "checks.jsonl"));
  const diagnoses = readJsonLines(join(plan.resultsDir, DIAGNOSES_FILE));
  const done = new Set(checks.map((line) => `${line.case}:${line.repeat}`));
  const lastChecks = lastCheckLines(checks);
  const runs = [];
  for (const entry of plan.cases) {
    for (let repeat = 1; repeat <= plan.iteration.repeats; repeat++) {
      const key = `${entry.id}:${repeat}`;
      if (!done.has(key)) {
        runs.push(planRun(plan, entry, repeat));
      } else if (plan.set === SET_DEV) {
        const lastCheck = lastChecks.find(
          (line) => line.case === entry.id && line.repeat === repeat,
        );
        if (lastCheck && !diagnosisOf(diagnoses, lastCheck))
          runs.push(planRunDiagnosisOnly(plan, entry, repeat, lastCheck));
      }
    }
  }
  return runs;
}

function refreshCanWrite(authPath, provider, validityMs) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return true;
  }
  const entry = raw?.[provider];
  if (!entry || entry.type !== OAUTH_TYPE) return false;
  const expires = entry.expires;
  if (typeof expires !== "number") return true;
  const minValidity = Math.max(5 * 60000, validityMs);
  return Date.now() + minValidity >= expires;
}

async function runPending(plan, deps) {
  plan.credValues = new Set(extractCredentialValues(plan.authPath));
  const jobs = plan.iteration.jobs ?? 1;
  const controller = deps._controller;
  const signal = controller?.signal;
  const origRefresh = deps.refresh;

  let inFlight = 0;
  let inFlightReserveSum = 0;
  const inFlightCases = new Set();
  const gate = createAuthGate();

  let firstStop = null;
  let taskError = null;
  let resolvePool;
  const poolDone = new Promise((r) => {
    resolvePool = r;
  });

  const pending = pendingRuns(plan);
  let activeTasks = 0;

  function tryResolvePool() {
    if (activeTasks === 0) resolvePool();
  }

  function tryStartNext() {
    if (firstStop || signal?.aborted) return;
    for (let i = 0; i < pending.length && inFlight < jobs; i++) {
      const run = pending[i];
      if (!run.diagnosisOnly && inFlightCases.has(run.caseId)) continue;
      const usd = run.diagnosisOnly ? run.config.judge_usd : run.caseJson.usd;
      if (!startGateOpen(run, usd, inFlightReserveSum)) break;
      pending.splice(i, 1);
      i--;
      runTask(run);
    }
  }

  const poolDeps = {
    ...deps,
    signal,
    gate,
    get inFlightReserveSum() {
      return inFlightReserveSum;
    },
    refresh: async (authPath, provider, validityMs) => {
      if (refreshCanWrite(authPath, provider, validityMs)) {
        await gate.exclusive(async () => {
          if (refreshCanWrite(authPath, provider, validityMs)) {
            await origRefresh(authPath, provider, validityMs);
          }
        });
      } else {
        await origRefresh(authPath, provider, validityMs);
      }
    },
  };

  async function runTask(run) {
    activeTasks++;
    try {
      const reserve = run.diagnosisOnly
        ? parseUsdCents(run.config.judge_usd) / CENTS_PER_DOLLAR
        : parseUsdCents(run.caseJson.usd) / CENTS_PER_DOLLAR;
      inFlight++;
      inFlightReserveSum += reserve;
      if (!run.diagnosisOnly) inFlightCases.add(run.caseId);
      const taskDeps = {
        ...poolDeps,
        get inFlightReserveSum() {
          return poolDeps.inFlightReserveSum - reserve;
        },
      };
      try {
        const result = await evaluateRun(run, taskDeps);
        if (result.stop && !firstStop) {
          firstStop = result;
          controller?.abort();
        }
      } catch (err) {
        if (!taskError) {
          taskError = err;
          firstStop = firstStop ?? { stop: "error" };
          controller?.abort();
        }
      } finally {
        inFlight--;
        inFlightReserveSum -= reserve;
        if (!run.diagnosisOnly) inFlightCases.delete(run.caseId);
      }
    } finally {
      activeTasks--;
      tryStartNext();
      tryResolvePool();
    }
  }

  tryStartNext();
  if (activeTasks === 0) resolvePool();
  await poolDone;

  if (taskError) throw taskError;
  if (firstStop) return firstStop;
  if (pending.length > 0) return { stop: STOP_CAP };
  return { stop: null };
}

export async function runPlan(plan, deps) {
  const setRealPath = realpathSync(plan.evalSetDir);
  mkdirSync(plan.resultsBaseDir, { recursive: true, mode: DIRECTORY_MODE });
  mkdirSync(plan.workBaseDir, { recursive: true, mode: DIRECTORY_MODE });
  const resultsBaseRealPath = realpathSync(plan.resultsBaseDir);
  const workRootRealPath = realpathSync(plan.workBaseDir);
  const makeWrapper = deps.makeWrapper ?? osDenyWrapper;
  const wrapper = makeWrapper(
    setRealPath,
    resultsBaseRealPath,
    workRootRealPath,
  );
  if (wrapper === null) {
    process.stderr.write(
      "evaluation: stop: OS read-deny mechanism is absent\n",
    );
    return EXIT_STOP;
  }
  const probeFile = join(setRealPath, ".git", "HEAD");
  try {
    readFileSync(probeFile);
  } catch {
    process.stderr.write(
      "evaluation: stop: the runner cannot read the probe file of the set\n",
    );
    return EXIT_STOP;
  }
  const probeError = wrapper.probe(process.execPath, probeFile);
  if (probeError !== null) {
    process.stderr.write(`evaluation: stop: ${probeError}\n`);
    return EXIT_STOP;
  }
  const controller = new AbortController();
  const runAgent = (args, stderrPath, allowedPaths, signal) =>
    deps.runAgent(args, stderrPath, wrapper, allowedPaths, signal);
  const result = await runPending(plan, {
    ...deps,
    runAgent,
    _controller: controller,
  });
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

export function checkResultKeys(resultLines, kindOf = new Map()) {
  const numbered = resultLines.map((line, index) => ({
    line,
    number: index + 1,
  }));
  const version = firstDifference(numbered, "engine_version");
  if (version) return version;
  const swe = numbered.filter((entry) => entry.line.agent === PROFILE_SWE);
  for (const key of SWE_GLOBAL_KEYS) {
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
  const byKind = Map.groupBy(swe, (entry) =>
    kindOf.get(caseOfSession(String(entry.line.session))),
  );
  for (const lines of byKind.values()) {
    for (const key of KIND_KEYS) {
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

function lastCheckLines(checks) {
  const byRun = new Map();
  for (const line of checks) byRun.set(`${line.case}:${line.repeat}`, line);
  return [...byRun.values()];
}

function diagnosisOf(diagnoses, check) {
  const runDir = dirname(check.session);
  return diagnoses.findLast((line) => dirname(line.session) === runDir);
}

function goodOnAspect(diagnosis, aspect) {
  if (!diagnosis?.valid) return false;
  return !diagnosis.findings.some(
    (finding) =>
      finding.aspect === aspect &&
      SEVERITIES_NOT_GOOD.includes(finding.severity),
  );
}

function goodRuns(report, checks, aspect) {
  return checks.filter((check) =>
    goodOnAspect(diagnosisOf(report.diagnoses, check), aspect),
  ).length;
}

function findingCounts(diagnoses, aspect) {
  const findings = diagnoses
    .flatMap((line) => line.findings)
    .filter((finding) => finding.aspect === aspect);
  return DIAGNOSIS_SEVERITIES.map((severity) => {
    const count = findings.filter((f) => f.severity === severity).length;
    return `${count} ${severity}`;
  }).join(", ");
}

function diagnosisLines(report) {
  const lines = [];
  for (const aspect of DIAGNOSIS_ASPECTS) {
    const counts = findingCounts(report.diagnoses, aspect);
    const good = DIAGNOSED_ASPECTS.includes(aspect)
      ? ` good runs: ${goodRuns(report, report.checks, aspect)},`
      : "";
    lines.push(`${aspect}${good} findings: ${counts}`);
  }
  const invalid = report.diagnoses.filter((line) => !line.valid).length;
  lines.push(`invalid diagnoses: ${invalid}`);
  return lines;
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
  if (report.iteration.set === SET_DEV) lines.push(...diagnosisLines(report));
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
  const stage1Parts = [];
  if (iteration.stage === BINDING_STAGE && report.stage1PassShares) {
    for (const s of report.stage1PassShares)
      stage1Parts.push(
        `stage 1 pass share ${s.kind} ${shareText(s.passes, s.planned)}`,
      );
  }
  const line = [
    ...shares,
    `gate_share ${iteration.gate_share}`,
    `breaches ${gate.breaches}`,
    `earlier held-out evaluations ${report.earlier}`,
    ...stage1Parts,
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
  const unstartedDiagnoses =
    report.iteration.set === SET_DEV
      ? `, unstarted diagnoses: ${planned - report.diagnoses.length}`
      : "";
  return [
    "## Cost",
    "",
    ...agentCostBlock(report.results, report.r, PROFILE_SWE),
    ...agentCostBlock(report.results, report.judgeR, PROFILE_RE),
    `cap_usd of each call: ${report.calls.map((line) => line.cap_usd).join(", ") || NONE_TEXT}`,
    `unstarted runs: ${planned - report.checks.length}${unstartedDiagnoses}`,
    "",
  ];
}

function devLines(report) {
  const { checks, cases, iteration } = report;
  const lines = ["## Dev cases", ""];
  const full = [];
  for (const entry of cases) {
    const own = checks.filter((line) => line.case === entry.id);
    const good = (key) => own.filter((line) => line[key]).length;
    const diagnosed = DIAGNOSED_ASPECTS.map(
      (aspect) => `${aspect} ${goodRuns(report, own, aspect)}`,
    ).join(", ");
    lines.push(
      `case ${entry.id}: passes ${good("pass")}, A1 ${good("a1")}, A2 ${good("a2")}, A3 ${good("a3")}, A4 ${good("a4")}, ${diagnosed}`,
    );
    if (own.length === iteration.repeats) full.push(good("pass"));
  }
  const ceiling = full.filter((passes) => passes === iteration.repeats).length;
  const floor = full.filter((passes) => passes === 0).length;
  const planned = cases.length * iteration.repeats;
  const complete =
    checks.length === planned && report.diagnoses.length === planned;
  const verdict = complete ? VERDICT_COMPLETE : VERDICT_NONE;
  lines.push(
    "",
    `set-difficulty: ${ceiling} ceiling, ${floor} floor of ${cases.length}`,
    ...(report.parent && !iteration.replicate ? [] : [`verdict ${verdict}`]),
    "",
  );
  return { lines, verdict };
}

function goodCountNoise(checks, diagnoses, aspect, isParent) {
  return checks.filter((check) =>
    goodOnRunNoise(check, diagnosisOf(diagnoses, check), aspect, isParent),
  ).length;
}

function iterationCounts(newReport, parentReport) {
  const target = newReport.iteration.aspect;
  const parentFlips = flipsCountForAspect(
    parentReport.checks,
    parentReport.diagnoses,
    target,
    true,
  );
  const passes = (report) => report.checks.filter((c) => c.pass).length;
  return {
    goodNew: goodCountNoise(
      newReport.checks,
      newReport.diagnoses,
      target,
      false,
    ),
    goodParent: goodCountNoise(
      parentReport.checks,
      parentReport.diagnoses,
      target,
      true,
    ),
    noiseTarget: Math.max(NOISE_FLOOR, parentFlips),
    passesNew: passes(newReport),
    passesParent: passes(parentReport),
    noisePass: Math.max(NOISE_FLOOR, passFlipsCount(parentReport.checks)),
  };
}

function hasEachPlannedLine(report) {
  const planned = report.cases.length * report.iteration.repeats;
  return (
    report.checks.length === planned && report.diagnoses.length === planned
  );
}

function noiseRuleVerdict(newReport, parentReport, counts) {
  if (newReport.checks.some((c) => c.breach)) return VERDICT_REVERT;
  if (!hasEachPlannedLine(newReport) || !hasEachPlannedLine(parentReport))
    return VERDICT_NONE;
  if (
    DIAGNOSED_ASPECTS.includes(newReport.iteration.aspect) &&
    newReport.reKeysDiffer
  )
    return VERDICT_NONE;
  const gain = counts.goodNew - counts.goodParent;
  const loss = counts.passesParent - counts.passesNew;
  if (gain >= counts.noiseTarget && loss < counts.noisePass)
    return VERDICT_KEEP;
  return VERDICT_REVERT;
}

function iterationLines(newReport, parentReport) {
  const counts = iterationCounts(newReport, parentReport);
  const verdict = noiseRuleVerdict(newReport, parentReport, counts);
  const diffs = ASPECT_VALUES.map((a) => {
    const gn = goodCountNoise(newReport.checks, newReport.diagnoses, a, false);
    const gp = goodCountNoise(
      parentReport.checks,
      parentReport.diagnoses,
      a,
      true,
    );
    return `${a} ${gn - gp}`;
  }).join(", ");
  const lines = [
    "## Iteration",
    "",
    `iteration: target ${newReport.iteration.aspect}, good parent ${counts.goodParent} new ${counts.goodNew} noise ${counts.noiseTarget}, passes parent ${counts.passesParent} new ${counts.passesNew} noise ${counts.noisePass}, verdict ${verdict}`,
    `diff: ${diffs}`,
    "",
  ];
  return { lines, verdict };
}

function aaLineText(newReport, parentReport) {
  const newChecks = newReport.checks;
  const parentChecks = parentReport.checks;
  const newDiagnoses = newReport.diagnoses ?? [];
  const parentDiagnoses = parentReport.diagnoses ?? [];
  const aspectParts = ASPECT_VALUES.map((a) => {
    const gFirst = goodCountNoise(parentChecks, parentDiagnoses, a, false);
    const gSecond = goodCountNoise(newChecks, newDiagnoses, a, false);
    const diff = gSecond - gFirst;
    const flips = flipsCountForAspect(parentChecks, parentDiagnoses, a, false);
    return `${a} ${gFirst} ${gSecond} diff ${diff} flips ${flips}`;
  });
  const passesFirst = parentChecks.filter((c) => c.pass).length;
  const passesSecond = newChecks.filter((c) => c.pass).length;
  const parts = [
    ...aspectParts,
    `passes ${passesFirst} ${passesSecond} diff ${passesSecond - passesFirst}`,
  ];
  return ["## A/A", "", `A/A: ${parts.join(", ")}`, ""];
}

function runRecords(report) {
  const checks = lastCheckLines(report.checks);
  const diagnoses = checks
    .map((check) => diagnosisOf(report.diagnoses ?? [], check))
    .filter((line) => line !== undefined);
  return { ...report, checks, diagnoses, judgeR: report.judgeR ?? null };
}

function iterationHeadLines(iteration) {
  if (!iteration.parent) return [];
  return [
    `parent: ${iteration.parent}`,
    `target aspect: ${iteration.aspect}`,
    `hypothesis: ${iteration.hypothesis}`,
  ];
}

export function buildReport(input) {
  const report = runRecords(input);
  const { iteration } = report;
  const sessions = new Set(report.checks.map((line) => line.session));
  const joined = report.results.filter((line) => sessions.has(line.session));
  const lines = [
    `# Evaluation ${report.evalId}`,
    "",
    `stage: ${iteration.stage}`,
    `set: ${iteration.set}`,
    `set commit: ${iteration.set_commit}`,
    ...iterationHeadLines(iteration),
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
    const dev = devLines(report);
    verdict = dev.verdict;
    lines.push(...dev.lines);
  }
  if (input.parent) {
    const parentReport = runRecords(input.parent);
    if (iteration.replicate) {
      lines.push(...aaLineText(report, parentReport));
    } else {
      const compared = iterationLines(report, parentReport);
      verdict = compared.verdict;
      lines.push(...compared.lines);
    }
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
  const report = buildReport({
    evalId,
    iteration,
    cases: evaluation.cases,
    r: evaluation.ratio.r,
    judgeR: evaluation.judgeRatio.r,
    earlier,
    checks: readJsonLines(join(resultsDir, "checks.jsonl")),
    results: readJsonLines(join(resultsDir, "results.jsonl")),
    calls: readJsonLines(join(resultsDir, "calls.jsonl")),
    diagnoses: readJsonLines(join(resultsDir, DIAGNOSES_FILE)),
    parent: evaluation.parentRecords ?? null,
    reKeysDiffer: evaluation.reKeysDiffer ?? false,
    stage1PassShares: evaluation.stage1PassShares ?? null,
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

function refusedReport(resultsDir, error) {
  rmSync(join(resultsDir, "report.md"), { force: true });
  return { error };
}

function pairError(pair) {
  const { iteration, parentIteration, results, parentResults } = pair;
  const comparability = comparabilityError(pair);
  if (comparability) return `comparability: ${comparability}`;
  const parentJobs = parentIteration.jobs ?? 1;
  const thisJobs = iteration.jobs ?? 1;
  if (parentJobs !== thisJobs)
    return `jobs: parent has ${parentJobs}, this evaluation has ${thisJobs}`;
  const digest = reDigestError(results, parentResults);
  if (digest) return `re@1: ${digest}`;
  if (iteration.replicate) return null;
  return oneChangeError(
    pair.engineRoot,
    parentIteration.engine_commit,
    iteration.engine_commit,
  );
}

function readPair(pair) {
  const { iteration, results, cases } = pair;
  const parentId = iteration.parent ?? iteration.replicate ?? null;
  if (parentId === null) return { parent: null, reKeysDiffer: false };
  const parentDir = join(pair.resultsBaseDir, parentId);
  const parentIteration = readJsonFile(join(parentDir, "iteration.json"));
  if (!isObject(parentIteration))
    return { error: `parent ${parentId}: no iteration.json` };
  const parentResults = readJsonLines(join(parentDir, "results.jsonl"));
  const error = pairError({ ...pair, parentIteration, parentResults });
  if (error) return { error };
  return {
    reKeysDiffer: reKeysDiffer(results, parentResults),
    parent: {
      evalId: parentId,
      iteration: parentIteration,
      cases,
      checks: readJsonLines(join(parentDir, "checks.jsonl")),
      diagnoses: readJsonLines(join(parentDir, DIAGNOSES_FILE)),
    },
  };
}

function lastPassedStageOneShares(resultsBaseDir, evalSetDir) {
  const cases = readCases(evalSetDir, SET_HELD_OUT);
  if (cases.error) return null;
  const evaluations = heldOutEvaluations(resultsBaseDir, 1).sort(
    (a, b) => b.startedMs - a.startedMs,
  );
  for (const entry of evaluations) {
    const checks = readJsonLines(
      join(resultsBaseDir, entry.id, "checks.jsonl"),
    );
    const gate = computeGate(lastCheckLines(checks), cases.cases, {
      repeats: entry.iteration.repeats,
      gateShare: entry.iteration.gate_share,
    });
    if (gate.verdict === VERDICT_PASS) return gate.shares;
  }
  return null;
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
  const kindOf = new Map(cases.cases.map((c) => [c.id, c.kind]));
  const difference = checkResultKeys(results, kindOf);
  if (difference) {
    const [first, second] = difference.lines;
    return refusedReport(
      resultsDir,
      `results.jsonl: lines ${first} and ${second} differ in ${difference.key}`,
    );
  }
  const pair = readPair({
    iteration,
    results,
    cases: cases.cases,
    resultsBaseDir,
    engineRoot: start.engineRoot ?? ENGINE_ROOT,
  });
  if (pair.error) return refusedReport(resultsDir, pair.error);
  const stage1PassShares =
    iteration.stage === BINDING_STAGE && iteration.set === SET_HELD_OUT
      ? lastPassedStageOneShares(resultsBaseDir, evalSetDir)
      : null;
  const verdict = writeReport({
    evalId: options.evalId,
    resultsDir,
    resultsBaseDir,
    iteration,
    cases: cases.cases,
    ratio: read.ratio,
    judgeRatio: read.judgeRatio,
    parentRecords: pair.parent,
    reKeysDiffer: pair.reKeysDiffer,
    stage1PassShares,
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
  if (plan.error) {
    if (plan.usageError) {
      process.stderr.write(`evaluation: ${plan.error}\n`);
      return EXIT_USAGE;
    }
    return refuse(plan.error);
  }
  return runPlan(plan, { refresh: refreshAuth, runAgent: runAgentProcess });
}

async function reportCommand(argv) {
  const result = await reportEvaluation({
    argv,
    env: process.env,
    engineRoot: ENGINE_ROOT,
    readPrices: readModelPrices,
  });
  if (result.error) return refuse(result.error);
  return result.verdict === VERDICT_NONE ? EXIT_NO_VERDICT : EXIT_OK;
}

function lineNumberOfOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function scanText(name, text) {
  let spans;
  try {
    spans = findPatternText(text);
  } catch {
    return null;
  }
  for (const span of spans) {
    const line = lineNumberOfOffset(text, span.start);
    process.stdout.write(`${name}:${line}:${span.rule}\n`);
  }
  return spans.length;
}

function stagedGit(args, encoding) {
  const env = isolatedGitEnvironment(process.env);
  if (process.env.GIT_INDEX_FILE)
    env.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
  const result = spawnSync("git", args, {
    env,
    encoding,
    maxBuffer: CHECK_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

function stagedEntries() {
  const raw = stagedGit(STAGED_DIFF_ARGS, "utf8");
  if (raw === null) return null;
  const fields = raw.split("\0");
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , blob] = fields[i].split(" ");
    if (mode !== GITLINK_MODE) entries.push({ name: fields[i + 1], blob });
  }
  return entries;
}

function stagedTexts() {
  const entries = stagedEntries();
  if (entries === null) return { error: "scan: git gives no staged files" };
  const texts = [];
  for (const entry of entries) {
    const content = stagedGit(["cat-file", "blob", entry.blob]);
    if (content === null)
      return { error: `scan: cannot read the staged ${entry.name}` };
    texts.push({ name: entry.name, text: content.toString("utf8") });
  }
  return { texts };
}

function listedTexts(paths) {
  const texts = [];
  for (const name of paths) {
    try {
      texts.push({ name, text: readFileSync(name, "utf8") });
    } catch {
      return { error: `scan: cannot read ${name}` };
    }
  }
  return { texts };
}

async function scanCommand(argv) {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    strict: true,
    allowPositionals: true,
  });
  const read =
    positionals.length === 0 ? stagedTexts() : listedTexts(positionals);
  if (read.error) return refuse(read.error);
  let matches = 0;
  for (const { name, text } of read.texts) {
    const count = scanText(name, text);
    if (count === null) return refuse(`scan: cannot scan ${name}`);
    matches += count;
  }
  return matches > 0 ? EXIT_STOP : EXIT_OK;
}

function validatedPathError(dir, strings) {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path);
    if (namesProtectedPath(`/${name}`, strings))
      return `rule 6: the path ${name} holds a protected string`;
    if (
      entry.isSymbolicLink() &&
      namesProtectedPath(readlinkSync(path), strings)
    )
      return `rule 6: the link ${name} holds a protected string`;
  }
  return null;
}

function validatedTextError(caseFolder, kind, strings) {
  const binding = join("binding", `${kind}.md`);
  const texts = [
    ["task.md", join(caseFolder, "task.md")],
    [binding, join(strings[0], binding)],
  ];
  for (const [name, path] of texts) {
    if (!existsSync(path)) return `no ${name}`;
    if (namesProtectedPath(readFileSync(path, "utf8"), strings))
      return `rule 6: ${name} holds a protected string`;
  }
  return null;
}

function validatedBaseError(caseFolder, caseJson, { root, limitMs }) {
  const dir = join(root, "c");
  const grade = {
    caseFolder,
    gradingDir: dir,
    checkTxtPath: join(root, "c.txt"),
    limitMs,
  };
  if (
    cloneSteps(join(caseFolder, "repo.bundle"), dir, caseJson.commit) === null
  )
    return "the clone failed";
  if (!runSetup(caseFolder, dir, limitMs)) return "setup.sh failed";
  const evalSetDir = resolve(caseFolder, "../../..");
  const strings = [evalSetDir, caseFolder, ...PROTECTED_PATH_PARTS];
  const held =
    validatedTextError(caseFolder, caseJson.kind, strings) ??
    validatedPathError(dir, strings);
  if (held) return held;
  if (!copyHiddenTests(join(caseFolder, "check", "tests"), dir))
    return "the copy of check/tests failed";
  if (runCheckMode(grade, MODE_FAIL_TO_PASS))
    return "rule 7: fail_to_pass exits 0 on C";
  const failed = [MODE_PASS_TO_PASS, MODE_CONVENTIONS].find(
    (mode) => !runCheckMode(grade, mode),
  );
  return failed ? `rule 7: ${failed} fails on C` : null;
}

function validatedReferenceError(caseFolder, caseJson, { root, limitMs }) {
  const diffPath = join(caseFolder, "check", "reference.patch");
  const scope = checkScope(readFileSync(diffPath, "latin1"), caseJson.allowed);
  if (!scope.pass) return `rule 8: reference.patch breaks ${scope.reason}`;
  for (let attempt = 1; attempt <= REFERENCE_TRIES; attempt++) {
    const graded = gradeRun({
      caseFolder,
      caseJson,
      diffPath,
      gradingDir: join(root, `g${attempt}`),
      checkTxtPath: join(root, `g${attempt}.txt`),
      limitMs,
    });
    if (graded.stop) return graded.stop;
    const failed = Object.keys(graded.aspects).filter(
      (aspect) => !graded.aspects[aspect],
    );
    if (failed.length > 0)
      return `rule 8: reference.patch fails ${failed.join(", ")} in try ${attempt} of ${REFERENCE_TRIES}`;
  }
  return null;
}

export async function validateCaseFolder(caseFolder, limitMs) {
  const caseJson = readJsonFile(join(caseFolder, "case.json"));
  const caseError = validateCase(caseJson);
  if (caseError) return caseError;
  const absent = VALIDATE_FILES.find(
    (name) => !existsSync(join(caseFolder, name)),
  );
  if (absent) return `no ${absent}`;
  const evalSetDir = resolve(caseFolder, "../../..");
  const manifestDiff = await checkManifestDiff(evalSetDir);
  if (manifestDiff !== null)
    return `manifest: ${manifestDiff}: tree differs from manifest`;
  const root = mkdtempSync(join(tmpdir(), "kanthord-validate-"));
  try {
    return (
      validatedBaseError(caseFolder, caseJson, { root, limitMs }) ??
      validatedReferenceError(caseFolder, caseJson, { root, limitMs })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function validateCommand(argv) {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length !== 1) return refuse("validate: pass one case folder");
  if (!existsSync(positionals[0]))
    return refuse(`validate: no folder ${positionals[0]}`);
  const error = await validateCaseFolder(realpathSync(positionals[0]));
  return error ? refuse(`validate: ${error}`) : EXIT_OK;
}

async function manifestCommand(argv) {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length !== 0) return refuse("manifest: pass no argument");
  const dirs = directories(process.env);
  const evalSetDir = join(dirs.data, "evaluation", "agent");
  const error = await writeManifest(evalSetDir);
  return error ? refuse(error) : EXIT_OK;
}

const COMMANDS = {
  run: runCommand,
  report: reportCommand,
  scan: scanCommand,
  validate: validateCommand,
  manifest: manifestCommand,
};

async function main(argv) {
  if (!Object.hasOwn(COMMANDS, argv[0]))
    return refuse("the subcommand is run, report, scan, validate or manifest");
  return COMMANDS[argv[0]](argv.slice(1));
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === SCRIPT_PATH
) {
  process.exit(await main(process.argv.slice(2)));
}
