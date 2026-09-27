import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

const element = (types, extra = {}) => ({ element: { types, ...extra } });
const file = (categories) => ({ file: { categories } });
const allow = (...types) => types.map((type) => ({ to: element(type) }));
const serviceEntry = (fileInternalPath) =>
  element("service", { fileInternalPath });
const applicationEntry = (type) =>
  element(type, { fileInternalPath: "index.ts" });

const comparisonLiteral =
  ':matches(Literal[value=type(string)], Literal[value=type(number)], TemplateLiteral[expressions.length=0], UnaryExpression[operator="-"][argument.type="Literal"][argument.value=type(number)])';
const comparisonMessage =
  "Use a meaningfully named enum member or constant instead of a string or numeric literal in a comparison.";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".data/**"] },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "kernel", pattern: "src/kernel" },
        { type: "repository", pattern: "src/repository" },
        {
          type: "service",
          pattern:
            "src/(custody|project|mission|scheduler|worker|tracking|gateway)",
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
          pattern: "src/config/{index.ts,index.test.ts,convict.d.ts}",
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
            { from: element("repository"), allow: allow("kernel") },
            { from: file("config-global"), allow: allow("kernel") },
            {
              from: file("config"),
              allow: [
                ...allow("kernel"),
                { to: file({ anyOf: ["config-global", "config"] }) },
                { to: serviceEntry("index.ts") },
              ],
            },
            {
              from: element("service"),
              allow: [
                ...allow("kernel"),
                { to: element("repository") },
                { to: file("config-global") },
                { to: serviceEntry("contract.ts") },
              ],
            },
            {
              from: element("apps-server"),
              allow: [
                ...allow("kernel"),
                { to: element("repository") },
                { to: file("config") },
                { to: serviceEntry("{index,contract}.ts") },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "{client,local}.ts",
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
                { to: serviceEntry("contract.ts") },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "{client,local}.ts",
                  }),
                },
              ],
            },
            {
              from: element("apps-worker"),
              allow: [
                ...allow("kernel"),
                { to: serviceEntry("contract.ts") },
                {
                  to: element("service", {
                    captured: { name: "gateway" },
                    fileInternalPath: "client.ts",
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
                    anyOf: ["kernel", "apps-server", "apps-cli", "apps-worker"],
                  }),
                },
                { from: file({ anyOf: ["config", "config-global", "main"] }) },
                { from: element("repository") },
                {
                  from: element("service", {
                    captured: { name: "!(gateway|project)" },
                  }),
                },
                {
                  from: element("service", {
                    captured: { name: "project" },
                    fileInternalPath: "!service.test.ts",
                  }),
                },
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
                { to: element("repository") },
              ],
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
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
      ],
    },
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/kernel/caller-mint.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/caller.ts"],
              importNames: ["callerProvenance"],
              message: "Only caller-mint.ts may access caller provenance.",
            },
          ],
        },
      ],
    },
  },
);
