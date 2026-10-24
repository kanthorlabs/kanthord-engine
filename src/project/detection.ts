import { z } from "zod";
import type { Environment } from "../kernel/devcontainer.ts";
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
  FlakeLock: "flake.lock",
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

const IMAGE_REGISTRY = "mcr.microsoft.com/devcontainers";
const IMAGE_VARIANT = "bookworm";
const BASE_IMAGE = `${IMAGE_REGISTRY}/base:${IMAGE_VARIANT}`;
const FEATURE_PREFIX = "ghcr.io/devcontainers/features";
const FEATURE_VERSION_NONE = "none";
const FEATURE_VERSION_LATEST = "latest";
const SINGLE_STACK = 1;
const DEFAULT_MAJOR_VERSION = "1";
const RUST_IMAGE_TAG = `1-${IMAGE_VARIANT}`;
const COMMAND_SEPARATOR = " && ";
const KANTHORD_HOME = "/var/lib/kanthord";
const COREPACK_HOME = "/usr/local/share/corepack";
const YARN_STABLE = "stable";
const YARN_CLASSIC_VERSION = "1.22.22";
const YARN_BERRY_MAJOR = 2;
const YARN_BERRY_MARKER = /^__metadata:/m;

const BASE_CONTAINER_ENV: Readonly<Record<string, string>> = {
  PATH: `${KANTHORD_HOME}/.local/bin:\${containerEnv:PATH}`,
  GOPATH: `${KANTHORD_HOME}/go`,
  CARGO_HOME: `${KANTHORD_HOME}/.cache/cargo`,
};

export const NIX_BASE_IMAGE = BASE_IMAGE;
export const NIX_FEATURE = `${FEATURE_PREFIX}/nix:1`;
export const NIX_FLAKE_DIRECTORY = "/etc/kanthord-flake";
export const NIX_ENV_FILE = "/etc/kanthord-nix-env.sh";
export const NIX_CHECK = "nix --version";
const NIX_ON_CREATE = `nix --extra-experimental-features 'nix-command flakes' print-dev-env ${NIX_FLAKE_DIRECTORY} > ${NIX_ENV_FILE}`;

const NodeCheck = {
  Node: "node --version",
  Npm: "npm --version",
  Pnpm: "pnpm --version",
  Yarn: "yarn --version",
} as const;
const PythonCheck = {
  Python: "python --version",
  Uv: "uv --version",
  Poetry: "poetry --version",
} as const;
const GO_CHECK = "go version";
const RUST_CHECK = "cargo --version";
const JAVA_CHECK = "java -version";

const NPM_CI = "npm ci";
const PNPM_INSTALL = "pnpm install --frozen-lockfile";
const YARN_IMMUTABLE_INSTALL = "yarn install --immutable";
const YARN_FROZEN_INSTALL = "yarn install --frozen-lockfile";
const COREPACK_ENABLE = "corepack enable";
const GO_DOWNLOAD = "go mod download";
const CARGO_FETCH = "cargo fetch";
const MAVEN_WRAPPER_FETCH = "./mvnw -B -q dependency:go-offline";
const MAVEN_FETCH = "mvn -B -q dependency:go-offline";
const GRADLE_WRAPPER_FETCH = "./gradlew --no-daemon dependencies";
const GRADLE_FETCH = "gradle --no-daemon dependencies";

type Draft = {
  onCreate?: string;
  update?: string;
  checks: string[];
  javaFeatureOptions?: Record<string, unknown>;
  containerEnv?: Record<string, string>;
};

type DraftSource = { files: readonly RepositoryFile[]; inputs: Inputs };

type StackRow = {
  image: (version: string) => string;
  featureVersion: (version: string) => string;
  draft: (source: DraftSource) => Draft;
};

const imageOf = (name: string) => (version: string) =>
  `${IMAGE_REGISTRY}/${name}:${version}-${IMAGE_VARIANT}`;
const sameVersion = (version: string) => version;
const latestForDefault = (version: string) =>
  version === DEFAULT_MAJOR_VERSION ? FEATURE_VERSION_LATEST : version;

function yarnVersion({ files, inputs }: DraftSource): string {
  const declared = packageManagerVersion(files, "yarn");
  if (declared !== LATEST_VERSION) return declared;
  return YARN_BERRY_MARKER.test(inputs.text(Path.YarnLock) ?? "")
    ? YARN_STABLE
    : YARN_CLASSIC_VERSION;
}

function yarnInstall(version: string): string {
  const berry =
    version === YARN_STABLE || Number.parseInt(version, 10) >= YARN_BERRY_MAJOR;
  return berry ? YARN_IMMUTABLE_INSTALL : YARN_FROZEN_INSTALL;
}

function nodeDraft(source: DraftSource): Draft {
  const { files, inputs } = source;
  if (inputs.has(Path.PnpmLock))
    return {
      onCreate: `npm install -g pnpm@${packageManagerVersion(files, "pnpm")}`,
      update: PNPM_INSTALL,
      checks: [NodeCheck.Node, NodeCheck.Pnpm],
    };
  if (inputs.has(Path.YarnLock)) {
    const version = yarnVersion(source);
    return {
      onCreate: `${COREPACK_ENABLE}${COMMAND_SEPARATOR}corepack prepare yarn@${version} --activate`,
      update: yarnInstall(version),
      checks: [NodeCheck.Node, NodeCheck.Yarn],
      containerEnv: { COREPACK_HOME },
    };
  }
  return {
    ...(inputs.has(Path.PackageLock) ? { update: NPM_CI } : {}),
    checks: [NodeCheck.Node, NodeCheck.Npm],
  };
}

function pythonDraft({ inputs }: DraftSource): Draft {
  if (inputs.has(Path.UvLock))
    return {
      onCreate: "pip install uv",
      update: "uv sync --frozen",
      checks: [PythonCheck.Python, PythonCheck.Uv],
    };
  if (inputs.has(Path.PoetryLock))
    return {
      onCreate: "pip install poetry",
      update: "poetry install --no-interaction",
      checks: [PythonCheck.Python, PythonCheck.Poetry],
    };
  return {
    ...(inputs.has(Path.Requirements)
      ? { update: "pip install --user -r requirements.txt" }
      : {}),
    checks: [PythonCheck.Python],
  };
}

function javaDraft({ inputs }: DraftSource): Draft {
  const checks = [JAVA_CHECK];
  if (inputs.has(Path.Mvnw)) return { update: MAVEN_WRAPPER_FETCH, checks };
  if (inputs.has(Path.PomXml))
    return {
      update: MAVEN_FETCH,
      checks,
      javaFeatureOptions: { installMaven: true },
    };
  if (inputs.has(Path.Gradlew)) return { update: GRADLE_WRAPPER_FETCH, checks };
  return {
    update: GRADLE_FETCH,
    checks,
    javaFeatureOptions: { installGradle: true },
  };
}

const STACK_TABLE: Record<DetectedStack, StackRow> = {
  [DetectedStack.Node]: {
    image: imageOf("javascript-node"),
    featureVersion: sameVersion,
    draft: nodeDraft,
  },
  [DetectedStack.Python]: {
    image: imageOf("python"),
    featureVersion: sameVersion,
    draft: pythonDraft,
  },
  [DetectedStack.Go]: {
    image: imageOf("go"),
    featureVersion: latestForDefault,
    draft: () => ({ update: GO_DOWNLOAD, checks: [GO_CHECK] }),
  },
  [DetectedStack.Rust]: {
    image: () => `${IMAGE_REGISTRY}/rust:${RUST_IMAGE_TAG}`,
    featureVersion: latestForDefault,
    draft: () => ({ update: CARGO_FETCH, checks: [RUST_CHECK] }),
  },
  [DetectedStack.Java]: {
    image: imageOf("java"),
    featureVersion: sameVersion,
    draft: javaDraft,
  },
};

type DetectedStackVersion = ReturnType<typeof detectStacks>[number];

type Planned = { detected: DetectedStackVersion; draft: Draft };

function featureOptions(
  { detected, draft }: Planned,
  single: boolean,
): Record<string, unknown> {
  const extra = draft.javaFeatureOptions ?? {};
  if (single) return { version: FEATURE_VERSION_NONE, ...extra };
  const version = STACK_TABLE[detected.stack].featureVersion(detected.version);
  return { version, ...extra };
}

function featuresOf(planned: Planned[]): Record<string, unknown> | null {
  const single = planned.length === SINGLE_STACK;
  const entries = planned.flatMap((entry) => {
    if (single && !entry.draft.javaFeatureOptions) return [];
    const name = `${FEATURE_PREFIX}/${entry.detected.stack}:1`;
    return [[name, featureOptions(entry, single)] as const];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function joined(parts: Array<string | undefined>): string | null {
  const present = parts.filter((part) => part !== undefined);
  return present.length ? present.join(COMMAND_SEPARATOR) : null;
}

type Detected = {
  stacks: DetectedStack[];
  document: Environment;
  checks: string[];
};

function flakeDetection(): Detected {
  const checks = [NIX_CHECK];
  const document: Environment = {
    image: NIX_BASE_IMAGE,
    features: { [NIX_FEATURE]: { multiUser: false } },
    containerEnv: { ...BASE_CONTAINER_ENV, BASH_ENV: NIX_ENV_FILE },
    onCreateCommand: NIX_ON_CREATE,
    customizations: { kanthord: { checks } },
  };
  return { stacks: [], document, checks };
}

export function detectEnvironment(
  files: readonly RepositoryFile[],
): Detected | null {
  const flake = files.find((file) => file.path === Path.FlakeNix);
  if (textOf(flake) !== null) return flakeDetection();
  const detected = detectStacks(files);
  if (!detected.length) return null;
  const source = { files, inputs: readInputs(files) };
  const planned = detected.map((entry) => ({
    detected: entry,
    draft: STACK_TABLE[entry.stack].draft(source),
  }));
  const drafts = planned.map((entry) => entry.draft);
  const checks = drafts.flatMap((draft) => draft.checks);
  const onCreate = joined(drafts.map((draft) => draft.onCreate));
  const update = joined(drafts.map((draft) => draft.update));
  const features = featuresOf(planned);
  const only = planned.length === SINGLE_STACK ? planned[0] : undefined;
  const image = only
    ? STACK_TABLE[only.detected.stack].image(only.detected.version)
    : BASE_IMAGE;
  const document: Environment = {
    image,
    ...(features ? { features } : {}),
    containerEnv: Object.assign(
      {},
      BASE_CONTAINER_ENV,
      ...drafts.map((draft) => draft.containerEnv ?? {}),
    ),
    ...(onCreate ? { onCreateCommand: onCreate } : {}),
    ...(update ? { updateContentCommand: update } : {}),
    customizations: { kanthord: { checks } },
  };
  return { stacks: detected.map((entry) => entry.stack), document, checks };
}
