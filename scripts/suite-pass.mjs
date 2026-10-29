import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildGraph,
  closureOf,
  floorOf,
  GLOBAL_INPUTS,
  runTests,
} from "./affected-tests.mjs";

const CONFIG_PATH = ".kanthord/suite-pass.json";
const CONFIG_VERSION = 1;
const CONFIG_KEYS = "always_run,version";
const DECLARATION_PATH = ".kanthord/affected-tests.json";
const EXTRA_GLOBAL_INPUTS = ["static/pi-tools.json"];
const STORE_PATH = join("node_modules", ".cache", "suite-pass", "records.json");
const STORE_VERSION = 1;
const MAX_RECORDS = 20000;
const RUN_COMMAND = "run";
const COMMAND_INDEX = 0;
const FILES_INDEX = 1;
const GIT = "git";
const PNPM = "pnpm";
const UTF8 = "utf8";
const NUL = "\0";
const NEWLINE = "\n";
const TAB = "\t";
const SPACE = " ";
const EMPTY = "";
const OID_INDEX = 2;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const GIT_TREE_ARGUMENTS = ["ls-tree", "-r", "-z", "HEAD"];
const GIT_STATUS_ARGUMENTS = ["status", "--porcelain", "--untracked-files=all"];
const PNPM_VERSION_ARGUMENTS = ["--version"];
const HASH_ALGORITHM = "sha256";
const HASH_ENCODING = "hex";
const SECONDS_ROUNDING = 10;
const PERCENT = 100;
const NO_SECONDS = 0;
const MIN_CONCURRENCY = 1;
const MAIN_MODULE_INDEX = 1;
const ARGUMENT_START = 2;
const SUCCESS_STATUS = 0;
const FAILED_EXIT_CODE = 1;
const ERROR_EXIT_CODE = 2;
const SUMMARY_ENVIRONMENT = "GITHUB_STEP_SUMMARY";
const EMPTY_RUN = { passed: true, ids: [], seconds: new Map() };
const USAGE_MESSAGE =
  "usage: suite-pass.mjs run --job <name> [--write] [--full] --concurrency <n> <test file>...";
const INVALID_CONFIG_MESSAGE = `invalid ${CONFIG_PATH}: `;
const CONFIG_SHAPE_MESSAGE = "expected version 1 and always_run";
const DIRTY_BEFORE_MESSAGE =
  "the work tree is not clean: --write needs a clean tree";
const DIRTY_AFTER_MESSAGE =
  "the test run left the work tree not clean: no record is written";

function git(root, args) {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: UTF8,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function isPath(value) {
  return typeof value === "string" && value.trim() !== EMPTY;
}

function readConfig(root) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(root, CONFIG_PATH), UTF8));
  } catch (error) {
    throw new Error(`${INVALID_CONFIG_MESSAGE}${error.message}`, {
      cause: error,
    });
  }
  const keys =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort().join()
      : EMPTY;
  const valid =
    keys === CONFIG_KEYS &&
    parsed.version === CONFIG_VERSION &&
    Array.isArray(parsed.always_run) &&
    parsed.always_run.every(isPath);
  if (!valid)
    throw new Error(`${INVALID_CONFIG_MESSAGE}${CONFIG_SHAPE_MESSAGE}`);
  return parsed.always_run;
}

function readGateFiles(root) {
  const path = join(root, DECLARATION_PATH);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, UTF8)).gate_files ?? [];
}

function readToolchain(root) {
  const pnpm = execFileSync(PNPM, PNPM_VERSION_ARGUMENTS, {
    cwd: root,
    encoding: UTF8,
  }).trim();
  return { node: process.versions.node, pnpm };
}

function readBlobs(root) {
  const blobs = new Map();
  for (const entry of git(root, GIT_TREE_ARGUMENTS).split(NUL)) {
    if (entry === EMPTY) continue;
    const separator = entry.indexOf(TAB);
    const oid = entry.slice(0, separator).split(SPACE)[OID_INDEX];
    blobs.set(entry.slice(separator + 1), oid);
  }
  return blobs;
}

function readState(root, toolchain) {
  const inputs = new Set([
    ...GLOBAL_INPUTS,
    ...EXTRA_GLOBAL_INPUTS,
    ...readGateFiles(root),
  ]);
  return { toolchain, blobs: readBlobs(root), inputs: [...inputs].sort() };
}

function pairsOf(blobs, paths) {
  return paths.map((path) => [path, blobs.get(path) ?? null]);
}

function keyWith(state, graph, file) {
  const canonical = JSON.stringify({
    node: state.toolchain.node,
    pnpm: state.toolchain.pnpm,
    inputs: pairsOf(state.blobs, state.inputs),
    closure: pairsOf(state.blobs, closureOf(graph, file)),
  });
  return createHash(HASH_ALGORITHM).update(canonical).digest(HASH_ENCODING);
}

export function keyOf(root, graph, file, toolchain) {
  return keyWith(readState(root, toolchain), graph, file);
}

function isDirty(root) {
  return git(root, GIT_STATUS_ARGUMENTS) !== EMPTY;
}

function readStore(root) {
  try {
    const store = JSON.parse(readFileSync(join(root, STORE_PATH), UTF8));
    const valid =
      store !== null &&
      typeof store === "object" &&
      store.version === STORE_VERSION &&
      store.records !== null &&
      typeof store.records === "object" &&
      !Array.isArray(store.records);
    return valid ? store.records : {};
  } catch {
    return {};
  }
}

function writeStore(root, records) {
  const newest = Object.entries(records)
    .sort(([, left], [, right]) =>
      String(right.written_at).localeCompare(String(left.written_at)),
    )
    .slice(0, MAX_RECORDS);
  const path = join(root, STORE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: STORE_VERSION, records: Object.fromEntries(newest) })}${NEWLINE}`,
  );
}

function roundSeconds(seconds) {
  return Math.round(seconds * SECONDS_ROUNDING) / SECONDS_ROUNDING;
}

function sumSeconds(files, secondsOf) {
  return files.reduce((sum, file) => sum + (secondsOf(file) ?? NO_SECONDS), 0);
}

function passedFiles(run, files) {
  const failed = new Set(run.ids.map(({ file }) => file));
  return files.filter((file) => run.seconds.has(file) && !failed.has(file));
}

function savedShare(skippedSeconds, ranSeconds) {
  const total = skippedSeconds + ranSeconds;
  return total > NO_SECONDS
    ? Math.round((skippedSeconds / total) * PERCENT)
    : 0;
}

function writeSummary(job, summary) {
  const text = [
    `### Suite pass: ${job}`,
    EMPTY,
    `Floor: ${summary.floorCount} test files, ${summary.floorSeconds} s`,
    `Ran: ${summary.ran} test files`,
    `Skipped: ${summary.skipped} test files`,
    `Saved share: ${summary.share}%`,
    EMPTY,
  ].join(NEWLINE);
  process.stdout.write(text);
  const summaryPath = process.env[SUMMARY_ENVIRONMENT];
  if (summaryPath) appendFileSync(summaryPath, `${text}${NEWLINE}`);
}

function execute(root, { job, write, full, concurrency }, files) {
  const dirty = isDirty(root);
  if (write && dirty) throw new Error(DIRTY_BEFORE_MESSAGE);
  const alwaysRun = new Set(readConfig(root));
  const graph = buildGraph(root);
  const state = readState(root, readToolchain(root));
  const keys = new Map(
    files.map((file) => [file, keyWith(state, graph, file)]),
  );
  const records = readStore(root);
  const isRecorded = (file) => Object.hasOwn(records, keys.get(file));
  const selected = files.filter(
    (file) => full || dirty || alwaysRun.has(file) || !isRecorded(file),
  );
  const skipped = files.filter((file) => !selected.includes(file));
  const writtenAt = new Date().toISOString();
  const run =
    selected.length === 0 ? EMPTY_RUN : runTests(root, selected, concurrency);
  const passed = passedFiles(run, selected);
  if (write) {
    if (isDirty(root)) throw new Error(DIRTY_AFTER_MESSAGE);
    for (const file of passed) {
      records[keys.get(file)] = {
        file,
        seconds: run.seconds.get(file),
        written_at: writtenAt,
      };
    }
    writeStore(root, records);
  }
  const argumentFiles = new Set(files);
  const floor = floorOf(graph).filter((file) => argumentFiles.has(file));
  const ranSeconds = (file) => run.seconds.get(file);
  writeSummary(job, {
    floorCount: floor.length,
    floorSeconds: roundSeconds(
      sumSeconds(
        floor.filter((file) => selected.includes(file)),
        ranSeconds,
      ),
    ),
    ran: selected.length,
    skipped: skipped.length,
    share: savedShare(
      sumSeconds(skipped, (file) => records[keys.get(file)]?.seconds),
      sumSeconds(selected, ranSeconds),
    ),
  });
  return run.passed && passed.length === selected.length
    ? SUCCESS_STATUS
    : FAILED_EXIT_CODE;
}

function parseConcurrency(text) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_CONCURRENCY) {
    throw new Error(USAGE_MESSAGE);
  }
  return value;
}

function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      job: { type: "string" },
      write: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
  });
  if (positionals[COMMAND_INDEX] !== RUN_COMMAND || !values.job) {
    throw new Error(USAGE_MESSAGE);
  }
  return execute(
    process.cwd(),
    { ...values, concurrency: parseConcurrency(values.concurrency) },
    positionals.slice(FILES_INDEX),
  );
}

if (
  process.argv[MAIN_MODULE_INDEX] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[MAIN_MODULE_INDEX]).href
) {
  try {
    process.exitCode = main(process.argv.slice(ARGUMENT_START));
  } catch (error) {
    process.stderr.write(`${error.message}${NEWLINE}`);
    process.exitCode = ERROR_EXIT_CODE;
  }
}
