import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

const element = (types, extra = {}) => ({ element: { types, ...extra } });
const file = (categories) => ({ file: { categories } });
const allow = (...types) => types.map((type) => ({ to: element(type) }));
const serviceEntry = (fileInternalPath) =>
  element("service", { fileInternalPath });
const applicationEntry = (type) =>
  element(type, { fileInternalPath: "index.ts" });

const workerFiles = ["src/worker/unit/**/*.ts", "src/apps/worker/**/*.ts"];
const workerTestFiles = [
  "src/worker/unit/**/*.test.ts",
  "src/apps/worker/**/*.test.ts",
  "src/worker/unit/**/test-support.ts",
  "src/apps/worker/**/test-support.ts",
  "src/apps/worker/**/*-test-support.ts",
];
const workerWrapperEntry = "src/apps/worker/index.ts";
const workerThreadEntry = "src/apps/worker/thread.ts";
const workerThreadStart = "src/apps/worker/thread-start.ts";
const workerSlotEntry = "src/apps/worker/slot.ts";
const workerPaths = (threads) => [
  { name: "node:sqlite", message: "A worker unit reaches no database." },
  ...(threads
    ? ["node:worker_threads", "worker_threads"].map((name) => ({
        name,
        allowTypeImports: true,
        message:
          "Only src/apps/worker/thread.ts, thread-start.ts and slot.ts use worker threads.",
      }))
    : []),
  ...["node:process", "process"].map((name) => ({
    name,
    message: "A worker unit reads no process state and signals no process.",
  })),
  ...["node:module", "module"].map((name) => ({
    name,
    message: "A worker unit loads no module by name.",
  })),
];
const workerPatterns = (production) => [
  {
    group: ["**/kernel/store.ts"],
    allowTypeImports: true,
    message: "A worker unit reaches no store.",
  },
  {
    group: ["**/repository/index.ts"],
    allowImportNames: ["RepositoryComponent"],
    message: "A worker unit uses only RepositoryComponent of the repository.",
  },
  ...(production
    ? [
        {
          group: ["**/test-support.ts", "**/*-test-support.ts"],
          message: "Only test files may import a test support file.",
        },
      ]
    : []),
];
const workerImportRule = ({ threads, production }) => [
  "error",
  { paths: workerPaths(threads), patterns: workerPatterns(production) },
];

const repositoryPathPrefixes = ["static/", "docs/", "src/", "scripts/", "bin/"];
const cwdReadFunctions = new Set([
  "readFileSync",
  "readFile",
  "existsSync",
  "resolve",
  "join",
]);
const cwdReadMessage =
  "Read a repository file through new URL(<relative path>, import.meta.url).";

const calleeName = (callee) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.name;
  }
  return undefined;
};

const constStringValue = (scope, name) => {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (!variable) continue;
    const definition = variable.defs[0];
    if (
      definition?.type !== "Variable" ||
      definition.parent.kind !== "const" ||
      definition.node.init?.type !== "Literal" ||
      typeof definition.node.init.value !== "string"
    ) {
      return undefined;
    }
    return definition.node.init.value;
  }
  return undefined;
};

const pathText = (context, argument) => {
  if (argument.type === "Literal") {
    return typeof argument.value === "string" ? argument.value : undefined;
  }
  if (argument.type === "TemplateLiteral") {
    return argument.quasis[0].value.cooked;
  }
  if (argument.type === "Identifier") {
    return constStringValue(
      context.sourceCode.getScope(argument),
      argument.name,
    );
  }
  return undefined;
};

const noCwdDataRead = {
  meta: { type: "problem", schema: [] },
  create: (context) => ({
    CallExpression: (node) => {
      if (!cwdReadFunctions.has(calleeName(node.callee))) return;
      const [argument] = node.arguments;
      if (!argument) return;
      const text = pathText(context, argument);
      if (!text) return;
      if (!repositoryPathPrefixes.some((prefix) => text.startsWith(prefix))) {
        return;
      }
      context.report({ node: argument, message: cwdReadMessage });
    },
  }),
};

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const allowedComments = JSON.parse(
  readFileSync(new URL(".kanthord/comments.json", import.meta.url), "utf8"),
);
const commentKey = (path, text) => JSON.stringify([path, text]);
const allowedCommentKeys = new Set(
  allowedComments.map(({ path, text }) => commentKey(path, text)),
);
const noCommentsMessage =
  "Write no comment. Only a human adds a comment to .kanthord/comments.json.";

const noComments = {
  meta: { type: "problem", schema: [] },
  create: (context) => ({
    Program: () => {
      const path = relative(repositoryRoot, context.filename);
      for (const comment of context.sourceCode.getAllComments()) {
        if (comment.type === "Shebang") continue;
        const text = context.sourceCode.getText(comment);
        if (allowedCommentKeys.has(commentKey(path, text))) continue;
        context.report({ loc: comment.loc, message: noCommentsMessage });
      }
    },
  }),
};

const kanthordPlugin = {
  rules: { "no-cwd-data-read": noCwdDataRead, "no-comments": noComments },
};

const productionImportPatterns = [
  {
    group: ["**/repository/test-sshd.ts"],
    importNames: ["startTestSshd"],
    message:
      "Only a test file imports startTestSshd, so the affected test selector sees each sshd test.",
  },
  {
    group: ["**/test-identity.ts"],
    message: "Only test files may import test-identity.ts.",
  },
  {
    group: ["**/caller.ts"],
    importNames: ["callerProvenance"],
    message:
      "Only caller-mint.ts and service-mint.ts may access caller provenance.",
  },
];
const slotTokenPattern = {
  group: ["**/auth/jwt.ts"],
  importNames: [
    "generateSlotJWT",
    "generateWorkerJWT",
    "generateInstanceClientJWT",
  ],
  message: "Only src/apps/server/ mints a slot token or an instance token.",
};

const comparisonLiteral =
  ':matches(Literal[value=type(string)], Literal[value=type(number)], TemplateLiteral[expressions.length=0], UnaryExpression[operator="-"][argument.type="Literal"][argument.value=type(number)])';
const valueNamePattern =
  "/^(ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|FIRST|SECOND|THIRD|FOURTH|EMPTY|NONE)$/";
const valueNameMessage =
  "Name a constant for its domain role, not for the English word of its value.";
const comparisonMessage =
  "Use a meaningfully named enum member or constant instead of a string or numeric literal in a comparison.";

const sqlCheckPattern = String.raw`/\bCHECK\s*\(/`;
const sqlIndexPattern = String.raw`/CREATE\s+INDEX/i`;
const sqlCheckMessage =
  "Declare no SQL CHECK constraint. The owning service validates the closed value set.";
const sqlIndexMessage = "Declare only a unique index.";

const syntaxRules = [
  ...[
    [sqlCheckPattern, sqlCheckMessage],
    [sqlIndexPattern, sqlIndexMessage],
  ].flatMap(([pattern, message]) => [
    { selector: `Literal[value=${pattern}]`, message },
    { selector: `TemplateElement[value.raw=${pattern}]`, message },
  ]),
  {
    selector: `BinaryExpression[operator=/^(===|!==|==|!=|<|<=|>|>=)$/] > ${comparisonLiteral}`,
    message: comparisonMessage,
  },
  {
    selector: `SwitchCase > ${comparisonLiteral}.test`,
    message: comparisonMessage,
  },
  ...[1, 2].map((position) => ({
    selector: `CallExpression[callee.object.name="assert"][callee.property.name=/^(equal|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual)$/] > ${comparisonLiteral}.arguments:nth-child(${position})`,
    message: comparisonMessage,
  })),
  {
    selector: `VariableDeclarator[id.name=${valueNamePattern}][init.type="Literal"]`,
    message: valueNameMessage,
  },
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      "Import a module by a literal specifier, so that the boundaries rule sees the import.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".data/**"] },
  {
    files: ["**/*.{ts,js,mjs}"],
    plugins: { kanthord: kanthordPlugin },
    rules: {
      "kanthord/no-comments": "error",
      "sort-imports": [
        "error",
        { ignoreDeclarationSort: true, ignoreCase: true },
      ],
    },
  },
  { linterOptions: { noInlineConfig: true } },
  {
    files: ["bin/**/*.mjs", "scripts/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "kernel", pattern: "src/kernel" },
        { type: "worker-unit", pattern: "src/worker/unit" },
        {
          type: "component",
          pattern: "src/(repository|llm|storage|agent)",
          capture: ["name"],
        },
        {
          type: "service",
          pattern:
            "src/(custody|project|mission|scheduler|worker|workbench|tracking|gateway|intake)",
          capture: ["name"],
        },
        { type: "apps-server", pattern: "src/apps/server" },
        { type: "apps-cli", pattern: "src/apps/cli" },
        { type: "apps-worker", pattern: "src/apps/worker" },
      ],
      "boundaries/files": [
        { category: "config-global", pattern: "src/config/global.ts" },
        {
          category: "config",
          pattern:
            "src/config/{index.ts,index.test.ts,path.ts,convict.d.ts,steps.ts,upgrade.ts,upgrade.test.ts}",
        },
        { category: "main", pattern: "src/main.ts" },
      ],
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/no-unknown-dependencies": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkInternals: true,
          policies: [
            { allow: [{ dependency: { relationship: { to: "internal" } } }] },
            { from: element("kernel"), allow: allow("kernel") },
            {
              from: element("component"),
              allow: [...allow("kernel"), { to: serviceEntry("contract.ts") }],
            },
            {
              from: element("component", { fileInternalPath: "*.test.ts" }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "custody" },
                    fileInternalPath: "{index,envelope}.ts",
                  }),
                },
                {
                  to: element("component", {
                    captured: { name: "agent" },
                    fileInternalPath: "pi.ts",
                  }),
                },
                { to: element("component", { fileInternalPath: "index.ts" }) },
              ],
            },
            { from: file("config-global"), allow: allow("kernel") },
            {
              from: file("config"),
              allow: [
                ...allow("kernel"),
                { to: file({ anyOf: ["config-global", "config"] }) },
                { to: serviceEntry("{index,config}.ts") },
                {
                  to: element("component", {
                    fileInternalPath: "{index,config}.ts",
                  }),
                },
              ],
            },
            {
              from: element("service"),
              allow: [
                ...allow("kernel"),
                { to: element("component") },
                { to: file("config-global") },
                { to: serviceEntry("contract.ts") },
              ],
            },
            {
              from: element("apps-server"),
              allow: [
                ...allow("kernel"),
                { to: element("component") },
                { to: file("config") },
                { to: serviceEntry("{index,contract}.ts") },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "{client.ts,local.ts,auth/jwt.ts}",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "project" },
                    fileInternalPath: "environment-state.ts",
                  }),
                },
                {
                  to: element("worker-unit", { fileInternalPath: "budget.ts" }),
                },
                {
                  to: element("apps-worker", {
                    fileInternalPath: "{thread-data,thread-start,frames}.ts",
                  }),
                },
              ],
            },
            {
              from: element("apps-server", {
                fileInternalPath: "{test-support.ts,*.test.ts}",
              }),
              allow: [
                { to: applicationEntry("apps-worker") },
                {
                  to: element("apps-worker", {
                    fileInternalPath:
                      "{transport,thread-data,evidence-upload,unit,handover}.ts",
                  }),
                },
                {
                  to: element("worker-unit", {
                    fileInternalPath: "{index,test-support}.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "{worker,mission}" },
                    fileInternalPath: "test-support.ts",
                  }),
                },
              ],
            },
            {
              from: element("apps-server", {
                fileInternalPath: "cli-support.ts",
              }),
              allow: [
                {
                  to: element("apps-cli", {
                    fileInternalPath: "test-support.ts",
                  }),
                },
              ],
            },
            {
              from: element("apps-cli"),
              allow: [
                ...allow("kernel"),
                { to: file("config") },
                { to: applicationEntry("apps-server") },
                { to: applicationEntry("apps-worker") },
                {
                  to: element("apps-worker", {
                    fileInternalPath: "{slot.ts,instance-config.ts}",
                  }),
                },
                { to: serviceEntry("contract.ts") },
                {
                  to: element("component", { fileInternalPath: "contract.ts" }),
                },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "{client.ts,local.ts,auth/jwt.ts}",
                  }),
                },
              ],
            },
            {
              from: element("apps-cli", { fileInternalPath: "*.test.ts" }),
              allow: [
                {
                  to: element("component", {
                    captured: { name: "{llm,repository,storage}" },
                    fileInternalPath: "index.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "intake" },
                    fileInternalPath: "configuration.ts",
                  }),
                },
              ],
            },
            {
              from: element({ anyOf: ["worker-unit", "apps-worker"] }),
              allow: [
                ...allow("kernel"),
                { to: serviceEntry("contract.ts") },
                {
                  to: element("component", { fileInternalPath: "contract.ts" }),
                },
                {
                  to: element("component", {
                    captured: { name: "agent" },
                    fileInternalPath: `{${[
                      "pi",
                      "pi-tools",
                      "bash-process",
                      "agent-session",
                      "environment",
                      "catalog",
                      "prompt-composer",
                      "prompt-render",
                      "prompt-templates",
                      "pinned-layers",
                    ].join(",")}}.ts`,
                  }),
                },
                {
                  to: element("component", {
                    captured: { name: "llm" },
                    fileInternalPath:
                      "{model-connector,platforms,provider,provider-failure,login,sessions}.ts",
                  }),
                },
                {
                  to: element("component", {
                    captured: { name: "repository" },
                    fileInternalPath: "index.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "custody" },
                    fileInternalPath: "client.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "{client,client-result}.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "worker" },
                    fileInternalPath: "catalog.ts",
                  }),
                },
              ],
            },
            {
              from: element("apps-worker"),
              allow: [
                {
                  to: element("worker-unit", { fileInternalPath: "index.ts" }),
                },
              ],
            },
            {
              from: element(
                { anyOf: ["worker-unit", "apps-worker"] },
                { fileInternalPath: "{test-support.ts,*.test.ts}" },
              ),
              allow: [
                {
                  to: element("worker-unit", {
                    fileInternalPath: "test-support.ts",
                  }),
                },
                {
                  to: element("component", {
                    captured: { name: "agent" },
                    fileInternalPath: "test-support.ts",
                  }),
                },
                {
                  to: element("component", {
                    captured: { name: "repository" },
                    fileInternalPath:
                      "{connector,node-branch,ssh-key,test-sshd}.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "worker" },
                    fileInternalPath: "test-support.ts",
                  }),
                },
              ],
            },
            {
              from: element({ anyOf: ["worker-unit", "apps-worker"] }),
              disallow: [
                {
                  to: element("kernel", {
                    fileInternalPath: "{test-identity,fatal}.ts",
                  }),
                },
              ],
            },
            {
              from: file("main"),
              allow: [
                ...allow("kernel"),
                { to: applicationEntry("apps-cli") },
                { to: applicationEntry("apps-server") },
              ],
            },
            {
              to: element("kernel", { fileInternalPath: "caller-mint.ts" }),
              disallow: [
                {
                  from: element({
                    anyOf: [
                      "apps-server",
                      "apps-cli",
                      "apps-worker",
                      "worker-unit",
                    ],
                  }),
                },
                {
                  from: element("kernel", {
                    fileInternalPath: "!test-identity.ts",
                  }),
                },
                { from: file({ anyOf: ["config", "config-global", "main"] }) },
                { from: element("component") },
                {
                  from: element("service", {
                    captured: { name: "!(gateway)" },
                  }),
                },
              ],
            },
            {
              to: element("kernel", { fileInternalPath: "service-mint.ts" }),
              disallow: [
                {
                  from: element({
                    anyOf: [
                      "component",
                      "service",
                      "apps-cli",
                      "apps-worker",
                      "worker-unit",
                    ],
                  }),
                },
                {
                  from: element("kernel", {
                    fileInternalPath: "!test-identity.ts",
                  }),
                },
                { from: file({ anyOf: ["config", "config-global", "main"] }) },
              ],
            },
            {
              from: serviceEntry("contract.ts"),
              disallow: [
                {
                  to: element({
                    anyOf: [
                      "service",
                      "apps-server",
                      "apps-cli",
                      "apps-worker",
                    ],
                  }),
                },
                { to: file({ anyOf: ["config-global", "config", "main"] }) },
                {
                  to: element("component", {
                    fileInternalPath: "!contract.ts",
                  }),
                },
              ],
            },
            {
              from: element("component", { fileInternalPath: "contract.ts" }),
              disallow: [
                {
                  to: element({
                    anyOf: ["apps-server", "apps-cli", "apps-worker"],
                  }),
                },
                {
                  to: element("service", { fileInternalPath: "!contract.ts" }),
                },
                {
                  to: element("component", {
                    fileInternalPath: "!contract.ts",
                  }),
                },
                { to: file({ anyOf: ["config-global", "config", "main"] }) },
              ],
            },
            {
              from: element("service", {
                captured: { name: "project" },
                fileInternalPath: "contract.ts",
              }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "custody" },
                    fileInternalPath: "contract.ts",
                  }),
                },
              ],
            },
            {
              from: element("service", {
                captured: { name: "project" },
                fileInternalPath: "onboarding.test.ts",
              }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "custody" },
                    fileInternalPath: "index.ts",
                  }),
                },
              ],
            },
            {
              from: element("service", {
                captured: { name: "scheduler" },
                fileInternalPath: "claim.test.ts",
              }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "project" },
                    fileInternalPath: "onboarding.ts",
                  }),
                },
              ],
            },
            {
              from: element("service", {
                captured: { name: "worker" },
                fileInternalPath: "execution-setup.test.ts",
              }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "project" },
                    fileInternalPath: "onboarding.ts",
                  }),
                },
              ],
            },
            {
              from: element("service", {
                captured: { name: "project" },
                fileInternalPath: "environment-secret.test.ts",
              }),
              allow: [
                {
                  to: element("service", {
                    captured: { name: "custody" },
                    fileInternalPath: "index.ts",
                  }),
                },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "test-support.ts",
                  }),
                },
              ],
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...syntaxRules],
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-else-return": "error",
      "no-param-reassign": "error",
      "no-lonely-if": "error",
      "prefer-object-spread": "error",
      "no-throw-literal": "error",
      "no-useless-rename": "error",
      "no-console": "error",
      "object-shorthand": "error",
      "no-useless-return": "error",
      "@typescript-eslint/no-extraneous-class": "error",
      "@typescript-eslint/no-useless-constructor": "error",
      "@typescript-eslint/prefer-literal-enum-member": "error",
      "@typescript-eslint/unified-signatures": "error",
      "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
      "@typescript-eslint/no-confusing-non-null-assertion": "error",
      "@typescript-eslint/adjacent-overload-signatures": "error",
      "@typescript-eslint/ban-tslint-comment": "error",
      "@typescript-eslint/class-literal-property-style": "error",
      "@typescript-eslint/consistent-type-assertions": "error",
      "@typescript-eslint/prefer-function-type": "error",
      "@typescript-eslint/consistent-indexed-object-style": "error",
      "@typescript-eslint/consistent-generic-constructors": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreUsingDeclarations: true },
      ],
    },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/caller.ts"],
              importNames: ["callerProvenance"],
              message:
                "Only caller-mint.ts and service-mint.ts may access caller provenance.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.test.ts",
      "src/**/*-support.ts",
      "src/**/test-support.ts",
    ],
    plugins: { kanthord: kanthordPlugin },
    rules: { "kanthord/no-cwd-data-read": "error" },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/*.test.ts",
      "src/kernel/caller-mint.ts",
      "src/kernel/service-mint.ts",
      "src/apps/server/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...productionImportPatterns, slotTokenPattern] },
      ],
    },
  },
  {
    files: ["src/apps/server/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: productionImportPatterns },
      ],
    },
  },
  {
    files: workerFiles,
    ignores: [
      workerThreadEntry,
      workerThreadStart,
      workerSlotEntry,
      ...workerTestFiles,
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": workerImportRule({
        threads: true,
        production: true,
      }),
    },
  },
  {
    files: [workerThreadEntry, workerThreadStart, workerSlotEntry],
    rules: {
      "@typescript-eslint/no-restricted-imports": workerImportRule({
        threads: false,
        production: true,
      }),
    },
  },
  {
    files: workerTestFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": workerImportRule({
        threads: true,
        production: false,
      }),
    },
  },
  {
    files: workerFiles,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...syntaxRules,
        {
          selector: "ImportExpression",
          message: "A worker unit imports its modules statically.",
        },
      ],
    },
  },
  {
    files: workerFiles,
    ignores: [workerWrapperEntry, workerThreadEntry, workerSlotEntry],
    rules: {
      "no-restricted-properties": [
        "error",
        ...[
          "env",
          "exit",
          "exitCode",
          "on",
          "once",
          "addListener",
          "kill",
          "abort",
          "dlopen",
        ].map((property) => ({
          object: "process",
          property,
          message:
            "A worker unit reads no process state and signals no process.",
        })),
      ],
    },
  },
  {
    files: workerFiles,
    ignores: [
      workerWrapperEntry,
      workerThreadEntry,
      workerSlotEntry,
      ...workerTestFiles,
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["process", "globalThis", "global"].map((name) => ({
          name,
          message:
            "A worker unit reads no process state and signals no process.",
        })),
      ],
    },
  },
);
