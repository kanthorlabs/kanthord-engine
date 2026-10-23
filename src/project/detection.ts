import { z } from "zod";
import { Diagnostic } from "../kernel/errors.ts";
import { isNumber, isObject, isString } from "../kernel/values.ts";
import { parseMapping } from "../kernel/yaml.ts";
import {
  RepositoryFileState,
  type RepositoryFile,
} from "../repository/contract.ts";

const Path = {
  Nvmrc: ".nvmrc",
  NodeVersion: ".node-version",
  PackageJson: "package.json",
  PnpmLock: "pnpm-lock.yaml",
  PackageLock: "package-lock.json",
  YarnLock: "yarn.lock",
  PythonVersion: ".python-version",
  Pyproject: "pyproject.toml",
  Requirements: "requirements.txt",
  UvLock: "uv.lock",
  PoetryLock: "poetry.lock",
  GoMod: "go.mod",
  CargoToml: "Cargo.toml",
  RustToolchainToml: "rust-toolchain.toml",
  RustToolchain: "rust-toolchain",
  PomXml: "pom.xml",
  Mvnw: "mvnw",
  BuildGradle: "build.gradle",
  BuildGradleKts: "build.gradle.kts",
  Gradlew: "gradlew",
  JavaVersion: ".java-version",
  ToolVersions: ".tool-versions",
  FlakeNix: "flake.nix",
} as const;

export const DETECTION_PATHS: readonly string[] = Object.freeze(
  Object.values(Path),
);

export const WORKFLOW_DIRECTORY = ".github/workflows";
export const WORKFLOW_FILES_MAX = 20;

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];
const EXPRESSION_MARKER = "${{";
const LATEST_VERSION = "latest";

export const DetectedStack = {
  Node: "node",
  Python: "python",
  Go: "go",
  Rust: "rust",
  Java: "java",
} as const;
export type DetectedStack = (typeof DetectedStack)[keyof typeof DetectedStack];
export const detectedStackSchema = z.enum(DetectedStack);

export function workflowPaths(listed: readonly string[]): string[] {
  const prefix = `${WORKFLOW_DIRECTORY}/`;
  return listed
    .filter((path) => {
      if (!path.startsWith(prefix)) return false;
      const name = path.slice(prefix.length);
      return (
        !name.includes("/") &&
        WORKFLOW_EXTENSIONS.some((extension) => name.endsWith(extension))
      );
    })
    .sort()
    .slice(0, WORKFLOW_FILES_MAX);
}

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | null {
  if (!isObject(value) || Array.isArray(value)) return null;
  return value as Mapping;
}

function textOf(file: RepositoryFile | undefined): string | null {
  return file?.state === RepositoryFileState.Present ? file.text : null;
}

function existsIn(file: RepositoryFile | undefined): boolean {
  return (
    file?.state === RepositoryFileState.Present ||
    file?.state === RepositoryFileState.TooLarge
  );
}

function packageJson(text: string | null): Mapping | null {
  if (text === null) return null;
  try {
    return asMapping(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function toolVersions(text: string | null): Map<string, string> {
  const versions = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const [tool, version] = line.trim().split(/\s+/);
    if (tool && version && !versions.has(tool)) versions.set(tool, version);
  }
  return versions;
}

const SETUP_ACTIONS = [
  { action: "actions/setup-node@", input: "node-version" },
  { action: "actions/setup-python@", input: "python-version" },
  { action: "actions/setup-go@", input: "go-version" },
  { action: "actions/setup-java@", input: "java-version" },
] as const;

type SetupInput = { input: string; value: string };

function setupInput(step: unknown): SetupInput | null {
  const mapping = asMapping(step);
  const inputs = asMapping(mapping?.with);
  const uses = mapping?.uses;
  if (!inputs || !isString(uses)) return null;
  const setup = SETUP_ACTIONS.find(({ action }) => uses.startsWith(action));
  if (!setup) return null;
  const raw = inputs[setup.input];
  const value = isNumber(raw) ? String(raw) : raw;
  if (!isString(value) || value.includes(EXPRESSION_MARKER)) return null;
  return { input: setup.input, value };
}

function workflowSteps(text: string): unknown[] {
  let document: Mapping;
  try {
    document = parseMapping(text);
  } catch (error) {
    if (error instanceof Diagnostic) return [];
    throw error;
  }
  const jobs = asMapping(document.jobs);
  if (!jobs) return [];
  return Object.values(jobs).flatMap((job) => {
    const steps = asMapping(job)?.steps;
    return Array.isArray(steps) ? (steps as unknown[]) : [];
  });
}

function setupInputsOf(files: Map<string, RepositoryFile>): SetupInput[] {
  return workflowPaths([...files.keys()])
    .flatMap((path) => workflowSteps(textOf(files.get(path)) ?? ""))
    .flatMap((step) => setupInput(step) ?? []);
}

type Inputs = {
  has: (path: string) => boolean;
  text: (path: string) => string | null;
  tool: (name: string) => string[];
  setup: (input: string) => string[];
  engineNode: string[];
  goModVersion: string[];
  channel: (text: string | null) => string[];
};

function present(...values: Array<string | null | undefined>): string[] {
  return values.filter((value) => value !== null && value !== undefined);
}

function readInputs(files: readonly RepositoryFile[]): Inputs {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const text = (path: string) => textOf(byPath.get(path));
  const tools = toolVersions(text(Path.ToolVersions));
  const setupInputs = setupInputsOf(byPath);
  const engines = asMapping(packageJson(text(Path.PackageJson))?.engines);
  const engineNode = engines?.node;
  const goModLine = /^go\s+(\S+)/m.exec(text(Path.GoMod) ?? "");
  return {
    has: (path) => existsIn(byPath.get(path)),
    text,
    tool: (name) => present(tools.get(name)),
    setup: (input) =>
      setupInputs.filter((entry) => entry.input === input).map((e) => e.value),
    engineNode: isString(engineNode)
      ? [engineNode.replace(/^[\s<>=~^v]*/, "")]
      : [],
    goModVersion: present(goModLine?.[1]),
    channel: (source) =>
      present(
        source === null
          ? null
          : /^\s*channel\s*=\s*["']([^"']*)["']/m.exec(source)?.[1],
      ),
  };
}

const majorOnly = (raw: string) => /^v?(\d+)/.exec(raw)?.[1] ?? null;
const majorMinor = (raw: string) => /^(\d+\.\d+)/.exec(raw)?.[1] ?? null;
const firstNumber = (raw: string) => /\d+/.exec(raw)?.[0] ?? null;
const digitStart = (raw: string) => (/^\d/.test(raw) ? raw : null);

type StackRule = {
  stack: DetectedStack;
  manifests: readonly string[];
  fallback: string;
  parse: (raw: string) => string | null;
  candidates: (inputs: Inputs) => string[];
};

const STACK_RULES: readonly StackRule[] = [
  {
    stack: DetectedStack.Node,
    manifests: [Path.PackageJson],
    fallback: "24",
    parse: majorOnly,
    candidates: (inputs) => [
      ...present(inputs.text(Path.Nvmrc), inputs.text(Path.NodeVersion)),
      ...inputs.tool("nodejs"),
      ...inputs.setup("node-version"),
      ...inputs.engineNode,
    ],
  },
  {
    stack: DetectedStack.Python,
    manifests: [Path.Pyproject, Path.Requirements],
    fallback: "3.12",
    parse: majorMinor,
    candidates: (inputs) => [
      ...present(inputs.text(Path.PythonVersion)),
      ...inputs.tool("python"),
      ...inputs.setup("python-version"),
    ],
  },
  {
    stack: DetectedStack.Go,
    manifests: [Path.GoMod],
    fallback: "1",
    parse: majorMinor,
    candidates: (inputs) => [
      ...inputs.tool("golang"),
      ...inputs.setup("go-version"),
      ...inputs.goModVersion,
    ],
  },
  {
    stack: DetectedStack.Rust,
    manifests: [Path.CargoToml],
    fallback: "1",
    parse: digitStart,
    candidates: (inputs) => {
      const file = inputs.text(Path.RustToolchain);
      return [
        ...inputs.channel(inputs.text(Path.RustToolchainToml)),
        ...inputs.channel(file),
        ...present(file),
        ...inputs.tool("rust"),
      ];
    },
  },
  {
    stack: DetectedStack.Java,
    manifests: [Path.PomXml, Path.BuildGradle, Path.BuildGradleKts],
    fallback: "21",
    parse: firstNumber,
    candidates: (inputs) => [
      ...present(inputs.text(Path.JavaVersion)),
      ...inputs.tool("java"),
      ...inputs.setup("java-version"),
    ],
  },
];

function versionOf(rule: StackRule, inputs: Inputs): string {
  for (const raw of rule.candidates(inputs)) {
    const version = rule.parse(raw.trim());
    if (version !== null) return version;
  }
  return rule.fallback;
}

export function detectStacks(
  files: readonly RepositoryFile[],
): Array<{ stack: DetectedStack; version: string }> {
  const inputs = readInputs(files);
  return STACK_RULES.filter((rule) => rule.manifests.some(inputs.has)).map(
    (rule) => ({ stack: rule.stack, version: versionOf(rule, inputs) }),
  );
}

export function packageManagerVersion(
  files: readonly RepositoryFile[],
  manager: "pnpm" | "yarn",
): string {
  const file = files.find((entry) => entry.path === Path.PackageJson);
  const declared = packageJson(textOf(file))?.packageManager;
  if (!isString(declared)) return LATEST_VERSION;
  const prefix = `${manager}@`;
  if (!declared.startsWith(prefix)) return LATEST_VERSION;
  return declared.slice(prefix.length).split("+")[0] || LATEST_VERSION;
}
