import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentSchema } from "../kernel/devcontainer.ts";
import type { RepositoryFile } from "../repository/contract.ts";
import {
  DETECTION_PATHS,
  DetectedStack,
  WORKFLOW_DIRECTORY,
  WORKFLOW_FILES_MAX,
  detectEnvironment,
  detectStacks,
  packageManagerVersion,
  workflowPaths,
} from "./detection.ts";

const file = (path: string, text: string): RepositoryFile => ({
  path,
  state: "present",
  text,
});
const tooLarge = (path: string): RepositoryFile => ({
  path,
  state: "too_large",
  text: null,
});
const workflow = (name: string, text: string) =>
  file(`${WORKFLOW_DIRECTORY}/${name}`, text);
const setupWorkflow = (action: string, input: string, value: string) =>
  workflow(
    "ci.yml",
    `jobs:\n  build:\n    steps:\n      - uses: ${action}\n        with:\n          ${input}: ${value}\n`,
  );

const MANIFEST = {
  [DetectedStack.Node]: file("package.json", "{}"),
  [DetectedStack.Python]: file("requirements.txt", ""),
  [DetectedStack.Go]: file("go.mod", ""),
  [DetectedStack.Rust]: file("Cargo.toml", ""),
  [DetectedStack.Java]: file("pom.xml", ""),
};

function expectVersion(
  stack: DetectedStack,
  files: RepositoryFile[],
  version: string,
) {
  const detected = detectStacks([MANIFEST[stack], ...files]);
  assert.deepEqual(
    detected.filter((entry) => entry.stack === stack),
    [{ stack, version }],
  );
}

test("a manifest gives its stack", () => {
  const cases: Array<[RepositoryFile, DetectedStack]> = [
    [file("package.json", "{}"), DetectedStack.Node],
    [tooLarge("package.json"), DetectedStack.Node],
    [file("pyproject.toml", ""), DetectedStack.Python],
    [file("requirements.txt", ""), DetectedStack.Python],
    [file("go.mod", ""), DetectedStack.Go],
    [file("Cargo.toml", ""), DetectedStack.Rust],
    [file("pom.xml", ""), DetectedStack.Java],
    [file("build.gradle", ""), DetectedStack.Java],
    [file("build.gradle.kts", ""), DetectedStack.Java],
  ];
  for (const [manifest, stack] of cases)
    assert.deepEqual(
      detectStacks([manifest]).map((entry) => entry.stack),
      [stack],
      manifest.path,
    );
});

test("a lock file or a version file alone gives no stack", () => {
  const files = [
    file("pnpm-lock.yaml", ""),
    file("yarn.lock", ""),
    file(".nvmrc", "20"),
    file(".python-version", "3.11"),
    file(".tool-versions", "nodejs 20"),
    file("uv.lock", ""),
    file("flake.nix", ""),
  ];
  assert.deepEqual(detectStacks(files), []);
  assert.deepEqual(detectStacks([]), []);
});

test("the stacks answer in a fixed order", () => {
  const files = Object.values(MANIFEST).reverse();
  assert.deepEqual(
    detectStacks(files).map((entry) => entry.stack),
    [
      DetectedStack.Node,
      DetectedStack.Python,
      DetectedStack.Go,
      DetectedStack.Rust,
      DetectedStack.Java,
    ],
  );
});

test("the node version follows the precedence", () => {
  const stack = DetectedStack.Node;
  const engines = file("package.json", '{"engines":{"node":">=18 <21"}}');
  const ci = setupWorkflow("actions/setup-node@v4", "node-version", "20");
  const tools = file(".tool-versions", "nodejs 18.19.0");
  const everything = [
    file(".nvmrc", "v20.11.0\n"),
    file(".node-version", "22"),
    tools,
    ci,
    engines,
  ];
  expectVersion(stack, everything, "20");
  expectVersion(stack, everything.slice(1), "22");
  expectVersion(stack, everything.slice(2), "18");
  expectVersion(stack, everything.slice(3), "20");
  expectVersion(stack, everything.slice(4), "18");
  expectVersion(stack, [], "24");
  expectVersion(
    stack,
    [file(".nvmrc", "lts/*"), file(".node-version", "22")],
    "22",
  );
  expectVersion(stack, [file(".nvmrc", "lts/*")], "24");
});

test("the python version follows the precedence", () => {
  const stack = DetectedStack.Python;
  const ci = setupWorkflow(
    "actions/setup-python@v5",
    "python-version",
    '"3.13"',
  );
  const tools = file(".tool-versions", "python 3.10.2");
  const everything = [file(".python-version", "3.11.4"), tools, ci];
  expectVersion(stack, everything, "3.11");
  expectVersion(stack, everything.slice(1), "3.10");
  expectVersion(stack, everything.slice(2), "3.13");
  expectVersion(stack, [], "3.12");
});

test("the go version follows the precedence", () => {
  const stack = DetectedStack.Go;
  const module = file("go.mod", "module x\n\ngo 1.21.5\n");
  const ci = setupWorkflow("actions/setup-go@v5", "go-version", "1.23");
  const tools = file(".tool-versions", "golang 1.22.1");
  const everything = [tools, ci, module];
  const goVersion = (files: RepositoryFile[]) =>
    detectStacks(files).filter((entry) => entry.stack === stack);
  assert.deepEqual(goVersion(everything), [{ stack, version: "1.22" }]);
  assert.deepEqual(goVersion(everything.slice(1)), [
    { stack, version: "1.23" },
  ]);
  assert.deepEqual(goVersion(everything.slice(2)), [
    { stack, version: "1.21" },
  ]);
  expectVersion(stack, [], "1");
});

test("the rust version follows the precedence", () => {
  const stack = DetectedStack.Rust;
  const toml = file("rust-toolchain.toml", '[toolchain]\nchannel = "1.79"\n');
  const plain = file("rust-toolchain", "1.80.1\n");
  const tools = file(".tool-versions", "rust 1.78.0");
  expectVersion(stack, [toml, plain, tools], "1.79");
  expectVersion(stack, [plain, tools], "1.80.1");
  expectVersion(stack, [tools], "1.78.0");
  expectVersion(stack, [], "1");
  expectVersion(
    stack,
    [file("rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n')],
    "1",
  );
});

test("the java version follows the precedence", () => {
  const stack = DetectedStack.Java;
  const ci = setupWorkflow("actions/setup-java@v4", "java-version", '"17"');
  const tools = file(".tool-versions", "java temurin-21.0.2+13");
  const everything = [file(".java-version", "17"), tools, ci];
  expectVersion(stack, everything, "17");
  expectVersion(stack, everything.slice(1), "21");
  expectVersion(stack, everything.slice(2), "17");
  expectVersion(stack, [], "21");
});

test("a workflow gives only a plain version of a setup action", () => {
  const stack = DetectedStack.Node;
  expectVersion(
    stack,
    [
      setupWorkflow(
        "actions/setup-node@v4",
        "node-version",
        "${{ matrix.node }}",
      ),
    ],
    "24",
  );
  expectVersion(stack, [workflow("ci.yml", "jobs: [")], "24");
  expectVersion(stack, [workflow("ci.yml", "jobs: 3")], "24");
  expectVersion(
    stack,
    [
      workflow(
        "ci.yml",
        "jobs:\n  a:\n    steps:\n      - run: setup node-version 20\n        with:\n          node-version: 20\n",
      ),
    ],
    "24",
  );
  expectVersion(
    stack,
    [setupWorkflow("actions/checkout@v4", "node-version", "20")],
    "24",
  );
  const first = setupWorkflow("actions/setup-node@v4", "node-version", "20");
  const second = {
    ...setupWorkflow("actions/setup-node@v4", "node-version", "22"),
    path: `${WORKFLOW_DIRECTORY}/a.yml`,
  };
  expectVersion(stack, [first, second], "22");
});

test("workflowPaths keeps the workflow files in path order", () => {
  const listed = [
    `${WORKFLOW_DIRECTORY}/b.yml`,
    `${WORKFLOW_DIRECTORY}/a.yaml`,
    `${WORKFLOW_DIRECTORY}/notes.md`,
    `${WORKFLOW_DIRECTORY}/nested/c.yml`,
    ".github/other/d.yml",
    "ci.yml",
  ];
  assert.deepEqual(workflowPaths(listed), [
    `${WORKFLOW_DIRECTORY}/a.yaml`,
    `${WORKFLOW_DIRECTORY}/b.yml`,
  ]);
  const many = Array.from(
    { length: WORKFLOW_FILES_MAX + 5 },
    (_, index) =>
      `${WORKFLOW_DIRECTORY}/w${String(index).padStart(2, "0")}.yml`,
  );
  assert.deepEqual(workflowPaths(many), many.slice(0, WORKFLOW_FILES_MAX));
});

test("the detection paths hold the 23 design paths in order", () => {
  assert.deepEqual(DETECTION_PATHS, [
    ".nvmrc",
    ".node-version",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    ".python-version",
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
    "poetry.lock",
    "go.mod",
    "Cargo.toml",
    "rust-toolchain.toml",
    "rust-toolchain",
    "pom.xml",
    "mvnw",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    ".java-version",
    ".tool-versions",
    "flake.nix",
  ]);
});

test("the package manager version comes from packageManager", () => {
  const manifest = (text: string) => [file("package.json", text)];
  const declared = manifest('{"packageManager":"pnpm@9.12.0+sha512.abc"}');
  assert.deepEqual(
    [
      packageManagerVersion(declared, "pnpm"),
      packageManagerVersion(declared, "yarn"),
      packageManagerVersion(manifest("{}"), "pnpm"),
      packageManagerVersion(manifest("{"), "pnpm"),
      packageManagerVersion([], "pnpm"),
      packageManagerVersion([tooLarge("package.json")], "pnpm"),
    ],
    ["9.12.0", "latest", "latest", "latest", "latest", "latest"],
  );
});

const BASE_ENV = {
  PATH: "/var/lib/kanthord/.local/bin:${containerEnv:PATH}",
  GOPATH: "/var/lib/kanthord/go",
  CARGO_HOME: "/var/lib/kanthord/.cache/cargo",
};
const COREPACK_ENV = { COREPACK_HOME: "/usr/local/share/corepack" };

type Expected = {
  image: string;
  onCreateCommand?: string;
  updateContentCommand?: string;
  checks: string[];
  features?: Record<string, unknown>;
  env?: Record<string, string>;
};

function expectDraft(files: RepositoryFile[], expected: Expected) {
  const drafted = detectEnvironment(files);
  assert.ok(drafted);
  assert.ok(environmentSchema.safeParse(drafted.document).success);
  assert.deepEqual(drafted.checks, expected.checks);
  assert.deepEqual(drafted.document, {
    image: expected.image,
    ...(expected.features ? { features: expected.features } : {}),
    containerEnv: { ...BASE_ENV, ...expected.env },
    ...(expected.onCreateCommand
      ? { onCreateCommand: expected.onCreateCommand }
      : {}),
    ...(expected.updateContentCommand
      ? { updateContentCommand: expected.updateContentCommand }
      : {}),
    customizations: { kanthord: { checks: expected.checks } },
  });
}

const NODE_20 = file(".nvmrc", "20");
const PACKAGE = file("package.json", "{}");
const packageManager = (value: string) =>
  file("package.json", JSON.stringify({ packageManager: value }));
const NODE_IMAGE =
  "mcr.microsoft.com/devcontainers/javascript-node:20-bookworm";
const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
const JAVA_FEATURE = "ghcr.io/devcontainers/features/java:1";

test("no manifest drafts no environment", () => {
  assert.equal(detectEnvironment([]), null);
  assert.equal(detectEnvironment([file(".nvmrc", "20")]), null);
});

test("a node repository drafts its install rows", () => {
  expectDraft(
    [NODE_20, packageManager("pnpm@9.12.0"), file("pnpm-lock.yaml", "")],
    {
      image: NODE_IMAGE,
      onCreateCommand: "npm install -g pnpm@9.12.0",
      updateContentCommand: "pnpm install --frozen-lockfile",
      checks: ["node --version", "pnpm --version"],
    },
  );
  expectDraft(
    [
      NODE_20,
      PACKAGE,
      file("yarn.lock", "# yarn\n__metadata:\n  version: 8\n"),
    ],
    {
      image: NODE_IMAGE,
      onCreateCommand:
        "corepack enable && corepack prepare yarn@stable --activate",
      updateContentCommand: "yarn install --immutable",
      checks: ["node --version", "yarn --version"],
      env: COREPACK_ENV,
    },
  );
  expectDraft([NODE_20, PACKAGE, file("yarn.lock", "# yarn lockfile v1\n")], {
    image: NODE_IMAGE,
    onCreateCommand:
      "corepack enable && corepack prepare yarn@1.22.22 --activate",
    updateContentCommand: "yarn install --frozen-lockfile",
    checks: ["node --version", "yarn --version"],
    env: COREPACK_ENV,
  });
  expectDraft([NODE_20, packageManager("yarn@4.5.0"), file("yarn.lock", "")], {
    image: NODE_IMAGE,
    onCreateCommand:
      "corepack enable && corepack prepare yarn@4.5.0 --activate",
    updateContentCommand: "yarn install --immutable",
    checks: ["node --version", "yarn --version"],
    env: COREPACK_ENV,
  });
  expectDraft(
    [
      NODE_20,
      packageManager("yarn@1.22.19"),
      file("yarn.lock", "__metadata:\n"),
    ],
    {
      image: NODE_IMAGE,
      onCreateCommand:
        "corepack enable && corepack prepare yarn@1.22.19 --activate",
      updateContentCommand: "yarn install --frozen-lockfile",
      checks: ["node --version", "yarn --version"],
      env: COREPACK_ENV,
    },
  );
  expectDraft([NODE_20, PACKAGE, file("package-lock.json", "")], {
    image: NODE_IMAGE,
    updateContentCommand: "npm ci",
    checks: ["node --version", "npm --version"],
  });
});

test("a python, go, rust or java repository drafts its install rows", () => {
  const python = "mcr.microsoft.com/devcontainers/python:3.12-bookworm";
  const pyproject = file("pyproject.toml", "");
  expectDraft([pyproject, file("uv.lock", "")], {
    image: python,
    onCreateCommand: "pip install uv",
    updateContentCommand: "uv sync --frozen",
    checks: ["python --version", "uv --version"],
  });
  expectDraft([pyproject, file("poetry.lock", "")], {
    image: python,
    onCreateCommand: "pip install poetry",
    updateContentCommand: "poetry install --no-interaction",
    checks: ["python --version", "poetry --version"],
  });
  expectDraft([file("requirements.txt", "")], {
    image: python,
    updateContentCommand: "pip install --user -r requirements.txt",
    checks: ["python --version"],
  });
  expectDraft([file("go.mod", "go 1.22.3\n")], {
    image: "mcr.microsoft.com/devcontainers/go:1.22-bookworm",
    updateContentCommand: "go mod download",
    checks: ["go version"],
  });
  expectDraft([file("Cargo.toml", "")], {
    image: "mcr.microsoft.com/devcontainers/rust:1-bookworm",
    updateContentCommand: "cargo fetch",
    checks: ["cargo --version"],
  });
  const java = "mcr.microsoft.com/devcontainers/java:21-bookworm";
  expectDraft([file("pom.xml", ""), file("mvnw", "")], {
    image: java,
    updateContentCommand: "./mvnw -B -q dependency:go-offline",
    checks: ["java -version"],
  });
  expectDraft([file("pom.xml", "")], {
    image: java,
    features: { [JAVA_FEATURE]: { version: "none", installMaven: true } },
    updateContentCommand: "mvn -B -q dependency:go-offline",
    checks: ["java -version"],
  });
  expectDraft([file("build.gradle", ""), file("gradlew", "")], {
    image: java,
    updateContentCommand: "./gradlew --no-daemon dependencies",
    checks: ["java -version"],
  });
  expectDraft([file("build.gradle.kts", "")], {
    image: java,
    features: { [JAVA_FEATURE]: { version: "none", installGradle: true } },
    updateContentCommand: "gradle --no-daemon dependencies",
    checks: ["java -version"],
  });
});

test("a lock file order decides between the rows", () => {
  expectDraft(
    [
      NODE_20,
      PACKAGE,
      file("package-lock.json", ""),
      file("pnpm-lock.yaml", ""),
    ],
    {
      image: NODE_IMAGE,
      onCreateCommand: "npm install -g pnpm@latest",
      updateContentCommand: "pnpm install --frozen-lockfile",
      checks: ["node --version", "pnpm --version"],
    },
  );
  expectDraft([file("requirements.txt", ""), file("uv.lock", "")], {
    image: "mcr.microsoft.com/devcontainers/python:3.12-bookworm",
    onCreateCommand: "pip install uv",
    updateContentCommand: "uv sync --frozen",
    checks: ["python --version", "uv --version"],
  });
  expectDraft([file("build.gradle", ""), file("pom.xml", "")], {
    image: "mcr.microsoft.com/devcontainers/java:21-bookworm",
    features: { [JAVA_FEATURE]: { version: "none", installMaven: true } },
    updateContentCommand: "mvn -B -q dependency:go-offline",
    checks: ["java -version"],
  });
});

test("a repository with no lock file drafts no install command", () => {
  expectDraft([NODE_20, PACKAGE], {
    image: NODE_IMAGE,
    checks: ["node --version", "npm --version"],
  });
  expectDraft([file("pyproject.toml", "")], {
    image: "mcr.microsoft.com/devcontainers/python:3.12-bookworm",
    checks: ["python --version"],
  });
});

test("two stacks draft the base image with one feature each", () => {
  expectDraft(
    [
      NODE_20,
      PACKAGE,
      file("package-lock.json", ""),
      file("go.mod", "go 1.22.1\n"),
    ],
    {
      image: BASE_IMAGE,
      features: {
        "ghcr.io/devcontainers/features/node:1": { version: "20" },
        "ghcr.io/devcontainers/features/go:1": { version: "1.22" },
      },
      updateContentCommand: "npm ci && go mod download",
      checks: ["node --version", "npm --version", "go version"],
    },
  );
  expectDraft([file("go.mod", ""), file("Cargo.toml", "")], {
    image: BASE_IMAGE,
    features: {
      "ghcr.io/devcontainers/features/go:1": { version: "latest" },
      "ghcr.io/devcontainers/features/rust:1": { version: "latest" },
    },
    updateContentCommand: "go mod download && cargo fetch",
    checks: ["go version", "cargo --version"],
  });
  expectDraft([file("go.mod", "")], {
    image: "mcr.microsoft.com/devcontainers/go:1-bookworm",
    updateContentCommand: "go mod download",
    checks: ["go version"],
  });
  expectDraft([file("pom.xml", ""), file("Cargo.toml", "")], {
    image: BASE_IMAGE,
    features: {
      "ghcr.io/devcontainers/features/rust:1": { version: "latest" },
      [JAVA_FEATURE]: { version: "21", installMaven: true },
    },
    updateContentCommand: "cargo fetch && mvn -B -q dependency:go-offline",
    checks: ["cargo --version", "java -version"],
  });
});

test("a draft answers the same document for another file order", () => {
  const files = [
    NODE_20,
    PACKAGE,
    file("yarn.lock", ""),
    file("go.mod", "go 1.22\n"),
    file("Cargo.toml", ""),
    file("pom.xml", ""),
    file("requirements.txt", ""),
  ];
  assert.deepEqual(
    detectEnvironment([...files].reverse()),
    detectEnvironment(files),
  );
});
