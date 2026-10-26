import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const GIT_LIST_ARGUMENTS = [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
];
const GIT_LIST_MAX_BUFFER = 256 * 1024 * 1024;
const PATH_SEPARATOR = "/";
const ROOT_PATHS = new Set([".", "./"]);
const PARENT_DIRECTORY = "..";
const PARENT_PREFIX = "../";
const RELATIVE_SPECIFIER = /^\.{1,2}(\/|$)/;
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/)/i;
const TEMPLATE_SUBSTITUTION = "${";
const URL_CONSTRUCTOR = "URL";
const URL_PROPERTY = "url";
const URL_ARGUMENT_COUNT = 2;
const START_TEST_SSHD = "startTestSshd";
const TEST_SSHD_MODULE = "src/repository/test-sshd.ts";
const E2E_PATTERN = /^src\/apps\/server\/e2e-[^/]*\.test\.ts$/;
const PARSED_PATTERNS = [
  /^src\/.*\.ts$/,
  /^scripts\/[^/]*\.mjs$/,
  /^bin\/[^/]*\.mjs$/,
];
const UNIT_TEST_PATTERN = /^src\/.*\.test\.ts$/;
const UNIT_TEST_SCRIPTS = new Set([
  "scripts/test-reporter.test.mjs",
  "scripts/test-path.test.mjs",
  "scripts/affected-tests.test.mjs",
]);
const DATA_TABLE = [
  { prefix: "static/openapi/", importer: "static/openapi.yaml" },
];

export const GLOBAL_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  "tsconfig.json",
  "tsconfig.build.json",
  ".kanthord/affected-tests.json",
  "scripts/test-path.mjs",
  "scripts/test-reporter.mjs",
  "scripts/affected-tests.mjs",
  "scripts/affected-reporter.mjs",
];

const INERT_DIRECTORIES = [
  "docs/",
  ".agents/",
  ".github/",
  ".husky/",
  ".opencode/",
];
const INERT_FILES = [
  "LICENSE",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "eslint.config.js",
  ".envrc",
  ".worktreeinclude",
];
const INERT_ROOT_SUFFIX = ".md";

export const INERT_INPUTS = [
  ...INERT_DIRECTORIES.map((directory) => `${directory}**`),
  `*${INERT_ROOT_SUFFIX}`,
  ...INERT_FILES,
];

const SELECTION = { all: "all", none: "none", selected: "selected" };
const GLOBAL_REASON = "global input: ";
const UNKNOWN_REASON = "unknown path: ";
const REASON_MAX_BYTES = 256;
const REPORT_VERSION = 1;
const TEXT_MAX_BYTES = 1024;
const LIST_MAX_ENTRIES = 10000;
const REPORT_MAX_BYTES = 1024 * 1024;
const REPORT_LISTS = ["tests", "failed", "flaky", "excluded_e2e"];
const DEFAULT_BASE = "origin/main";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const NUL = "\0";
const CHANGE_STATUS = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};
const NAME_STATUS_LETTERS = {
  A: CHANGE_STATUS.added,
  M: CHANGE_STATUS.modified,
  T: CHANGE_STATUS.modified,
  U: CHANGE_STATUS.modified,
  D: CHANGE_STATUS.deleted,
  R: CHANGE_STATUS.renamed,
};
const SUCCESS_STATUS = 0;
const FAILED_EXIT_CODE = 1;
const ERROR_EXIT_CODE = 2;
const FIRST_RUN_CONCURRENCY = 8;
const RERUN_CONCURRENCY = 1;
const RUN_TEMPORARY_PREFIX = "kanthord-affected-";
const FAILED_FILE_NAME = "failed.jsonl";
const AFFECTED_REPORTER = "./scripts/affected-reporter.mjs";
const PNPM = "pnpm";
const CHANGES_ENVIRONMENT = "KANTHORD_CHANGES";
const REPORT_ENVIRONMENT = "KANTHORD_AFFECTED_REPORT";

function listFiles(root) {
  const output = execFileSync("git", GIT_LIST_ARGUMENTS, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  return output.split("\0").filter((path) => path !== "");
}

function isOutside(path) {
  return path === PARENT_DIRECTORY || path.startsWith(PARENT_PREFIX);
}

function resolveRelative(importer, specifier) {
  return posix.join(posix.dirname(importer), specifier);
}

function resolveImport(importer, specifier) {
  if (!RELATIVE_SPECIFIER.test(specifier)) return null;
  const resolved = resolveRelative(importer, specifier);
  return isOutside(resolved) ? null : resolved;
}

function resolveData(importer, text) {
  if (text === "" || ABSOLUTE_URL.test(text)) return null;
  const resolved = resolveRelative(importer, text);
  if (isOutside(resolved) || ROOT_PATHS.has(resolved)) return null;
  return resolved;
}

function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === URL_PROPERTY
  );
}

function isUrlConstruction(node) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === URL_CONSTRUCTOR &&
    node.arguments?.length === URL_ARGUMENT_COUNT &&
    isImportMetaUrl(node.arguments[1])
  );
}

function importsStartTestSshd(importer, node) {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  const resolved = resolveImport(importer, node.moduleSpecifier.text);
  if (resolved !== TEST_SSHD_MODULE) return false;
  return bindings.elements.some(
    (element) =>
      (element.propertyName ?? element.name).text === START_TEST_SSHD,
  );
}

function importSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  return null;
}

function dataEdge(importer, node) {
  const [literal] = node.arguments;
  if (ts.isStringLiteralLike(literal)) {
    if (literal.text.endsWith(PATH_SEPARATOR)) {
      return { prefix: resolveData(importer, literal.text) };
    }
    return { file: resolveData(importer, literal.text) };
  }
  if (ts.isTemplateExpression(literal)) {
    const [text] = literal.head.text.split(TEMPLATE_SUBSTITUTION);
    return { prefix: resolveData(importer, text) };
  }
  return {};
}

function parseFile(root, path) {
  const source = readFileSync(join(root, path), "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
  const parsed = { files: [], prefixes: [], importsStartTestSshd: false };
  const visit = (node) => {
    const specifier = importSpecifier(node);
    const resolved = specifier === null ? null : resolveImport(path, specifier);
    if (resolved !== null) parsed.files.push(resolved);
    if (ts.isImportDeclaration(node) && importsStartTestSshd(path, node)) {
      parsed.importsStartTestSshd = true;
    }
    if (isUrlConstruction(node)) {
      const edge = dataEdge(path, node);
      if (edge.file) parsed.files.push(edge.file);
      if (edge.prefix) parsed.prefixes.push(edge.prefix);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return parsed;
}

function addImporter(importersByFile, file, importer) {
  if (!importersByFile.has(file)) importersByFile.set(file, new Set());
  importersByFile.get(file).add(importer);
}

function buildGraph(root) {
  const nodes = new Set(listFiles(root));
  const present = new Set(
    [...nodes].filter((path) => existsSync(join(root, path))),
  );
  const importersByFile = new Map();
  const prefixEdges = DATA_TABLE.map(({ prefix, importer }) => ({
    prefix,
    importer,
  }));
  const sshdImporters = new Set();
  for (const path of present) {
    if (!PARSED_PATTERNS.some((pattern) => pattern.test(path))) continue;
    const parsed = parseFile(root, path);
    for (const file of parsed.files) addImporter(importersByFile, file, path);
    for (const prefix of parsed.prefixes) {
      prefixEdges.push({ prefix, importer: path });
    }
    if (parsed.importsStartTestSshd) sshdImporters.add(path);
  }
  return { nodes, present, importersByFile, prefixEdges, sshdImporters };
}

function importersOf(graph, path) {
  const importers = new Set(graph.importersByFile.get(path));
  for (const { prefix, importer } of graph.prefixEdges) {
    if (path.startsWith(prefix)) importers.add(importer);
  }
  return importers;
}

function isNamedByEdge(graph, path) {
  return importersOf(graph, path).size > 0;
}

function isInert(path) {
  return (
    INERT_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
    INERT_FILES.includes(path) ||
    (!path.includes(PATH_SEPARATOR) && path.endsWith(INERT_ROOT_SUFFIX))
  );
}

function isE2e(graph, path) {
  if (E2E_PATTERN.test(path)) return true;
  return UNIT_TEST_PATTERN.test(path) && graph.sshdImporters.has(path);
}

function isUnitTest(graph, path) {
  return (
    (UNIT_TEST_PATTERN.test(path) || UNIT_TEST_SCRIPTS.has(path)) &&
    !isE2e(graph, path)
  );
}

function walk(graph, starts) {
  const reached = new Set(starts);
  const queue = [...starts];
  for (const path of queue) {
    const unreached = [...importersOf(graph, path)].filter(
      (importer) => !reached.has(importer),
    );
    for (const importer of unreached) reached.add(importer);
    queue.push(...unreached);
  }
  return reached;
}

function truncateBytes(text, maxBytes) {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

function everything(graph, reason) {
  const present = [...graph.present];
  return {
    selection: SELECTION.all,
    reason: truncateBytes(reason, REASON_MAX_BYTES),
    tests: present.filter((path) => isUnitTest(graph, path)).sort(),
    excluded_e2e: present.filter((path) => isE2e(graph, path)).sort(),
  };
}

export function selectTests(root, changes) {
  const graph = buildGraph(root);
  const paths = changes.flatMap((change) =>
    change.previous_path ? [change.path, change.previous_path] : [change.path],
  );
  const globalPath = paths.find((path) => GLOBAL_INPUTS.includes(path));
  if (globalPath !== undefined) {
    return everything(graph, `${GLOBAL_REASON}${globalPath}`);
  }
  const unknownPath = changes.find(
    ({ path }) =>
      !graph.nodes.has(path) && !isNamedByEdge(graph, path) && !isInert(path),
  )?.path;
  if (unknownPath !== undefined) {
    return everything(graph, `${UNKNOWN_REASON}${unknownPath}`);
  }
  const reached = [...walk(graph, new Set(paths))].filter((path) =>
    graph.present.has(path),
  );
  const tests = reached.filter((path) => isUnitTest(graph, path)).sort();
  return {
    selection: tests.length === 0 ? SELECTION.none : SELECTION.selected,
    reason: null,
    tests,
    excluded_e2e: reached.filter((path) => isE2e(graph, path)).sort(),
  };
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function parseNameStatus(output) {
  const tokens = output.split(NUL);
  tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = NAME_STATUS_LETTERS[tokens[index][0]];
    if (status === undefined) {
      throw new Error(`unknown git status: ${tokens[index]}`);
    }
    if (status === CHANGE_STATUS.renamed) {
      changes.push({
        path: tokens[index + 2],
        status,
        previous_path: tokens[index + 1],
      });
      index += 3;
    } else {
      changes.push({ path: tokens[index + 1], status });
      index += 2;
    }
  }
  return changes;
}

export function readChanges(path) {
  return JSON.parse(readFileSync(path, "utf8")).files;
}

export function computeChanges(root, base) {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const tracked = parseNameStatus(
    git(root, ["diff", "--name-status", "-z", "--find-renames", mergeBase]),
  );
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split(NUL)
    .filter((path) => path !== "")
    .map((path) => ({ path, status: CHANGE_STATUS.added }));
  return [...tracked, ...untracked];
}

function runTests(root, files, concurrency) {
  const directory = mkdtempSync(join(tmpdir(), RUN_TEMPORARY_PREFIX));
  try {
    const destination = join(directory, FAILED_FILE_NAME);
    const result = spawnSync(
      PNPM,
      [
        "--silent",
        "run",
        "test:files",
        `--test-concurrency=${concurrency}`,
        `--test-reporter=${AFFECTED_REPORTER}`,
        "--test-reporter-destination=stdout",
        `--test-reporter-destination=${destination}`,
        ...files,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    const ids = existsSync(destination)
      ? readFileSync(destination, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
    return { passed: result.status === SUCCESS_STATUS, ids };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function idKey({ file, name }) {
  return JSON.stringify([file, name]);
}

function uniqueIds(ids) {
  return [...new Map(ids.map((id) => [idKey(id), id])).values()];
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIds(left, right) {
  return (
    compareText(left.file, right.file) || compareText(left.name, right.name)
  );
}

function cutId({ file, name }) {
  return {
    file: truncateBytes(file, TEXT_MAX_BYTES),
    name: truncateBytes(name, TEXT_MAX_BYTES),
  };
}

function cutIds(ids) {
  return uniqueIds(ids.map(cutId)).sort(compareIds).slice(0, LIST_MAX_ENTRIES);
}

function cutPaths(paths) {
  return paths
    .map((path) => truncateBytes(path, TEXT_MAX_BYTES))
    .slice(0, LIST_MAX_ENTRIES);
}

function longestList(report) {
  return REPORT_LISTS.reduce((longest, list) =>
    report[list].length > report[longest].length ? list : longest,
  );
}

function fitSize(report) {
  let list = longestList(report);
  while (
    Buffer.byteLength(JSON.stringify(report)) > REPORT_MAX_BYTES &&
    report[list].length > 1
  ) {
    report[list] = report[list].slice(0, Math.ceil(report[list].length / 2));
    list = longestList(report);
  }
  return report;
}

function buildReport(selected, failed, flaky) {
  const cutFailed = cutIds(failed);
  const failedKeys = new Set(cutFailed.map(idKey));
  return fitSize({
    version: REPORT_VERSION,
    selection: selected.selection,
    reason: selected.reason,
    tests: cutPaths(selected.tests),
    failed: cutFailed,
    flaky: cutIds(flaky).filter((id) => !failedKeys.has(idKey(id))),
    excluded_e2e: cutPaths(selected.excluded_e2e),
  });
}

function rerunFailures(root, file) {
  const rerun = runTests(root, [file], RERUN_CONCURRENCY);
  const crashed = !rerun.passed && rerun.ids.length === 0;
  return { crashed, keys: new Set(rerun.ids.map(idKey)) };
}

export function affectedReport(root, changes) {
  const selected = selectTests(root, changes);
  if (selected.selection === SELECTION.none) {
    return buildReport(selected, [], []);
  }
  const first = runTests(root, selected.tests, FIRST_RUN_CONCURRENCY);
  const tests = new Set(selected.tests);
  const failed = uniqueIds(first.ids.filter(({ file }) => tests.has(file)));
  if (!first.passed && failed.length === 0) {
    throw new Error("the test run failed without a failed test");
  }
  const reruns = new Map(
    [...new Set(failed.map(({ file }) => file))].map((file) => [
      file,
      rerunFailures(root, file),
    ]),
  );
  const stays = (id) => {
    const rerun = reruns.get(id.file);
    return rerun.crashed || rerun.keys.has(idKey(id));
  };
  return buildReport(
    selected,
    failed.filter(stays),
    failed.filter((id) => !stays(id)),
  );
}

function main() {
  const { values } = parseArgs({
    options: { base: { type: "string", default: DEFAULT_BASE } },
  });
  const root = process.cwd();
  const changesPath = process.env[CHANGES_ENVIRONMENT];
  const changes = changesPath
    ? readChanges(changesPath)
    : computeChanges(root, values.base);
  const report = affectedReport(root, changes);
  const text = JSON.stringify(report);
  const reportPath = process.env[REPORT_ENVIRONMENT];
  if (reportPath) writeFileSync(reportPath, text);
  process.stdout.write(`${text}\n`);
  process.exitCode =
    report.failed.length === 0 ? SUCCESS_STATUS : FAILED_EXIT_CODE;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = ERROR_EXIT_CODE;
  }
}
