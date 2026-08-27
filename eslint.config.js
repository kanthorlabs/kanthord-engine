// Import-boundary enforcement for the six-directory architecture (AGENTS.md).
// Elements classify folders; `boundaries/files` classifies the two files that
// carry a rule of their own — a service interface, and the composition root.
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

const gitLibraries = ["isomorphic-git", "simple-git", "nodegit"];

const nodeEdgeWritePattern = String.raw`\b(insert\s+into|update|delete\s+from)\s+[\x22\x27\x60\x5b]?(node|edge)\b`;
const nodeEdgeWriteMessage =
  "a node or edge write belongs in src/services/plan/sqlite.ts";

// The only files that may hold a node or edge write. src/services/plan/sqlite.ts
// is the mutation boundary. The rest are pre-existing test fixtures that seed
// rows with raw SQL; a NEW file belongs on neither list — seed through
// test/helpers/rows.ts instead.
const nodeEdgeWriteExemptions = [
  "src/services/plan/sqlite.ts",
  "src/commands/plan/import-plan.test.ts",
  "src/commands/provider/remove-provider.test.ts",
  "src/commands/startup/recover-expired-leases.test.ts",
  "src/http/server/plan/import-plan.test.ts",
  "src/queries/edge/list-edge.test.ts",
  "src/queries/node/list-node.test.ts",
  "src/queries/node/list-project-node.test.ts",
  "src/queries/node/show-node.test.ts",
  "src/queries/plan/export-plan.test.ts",
  "src/queries/plan/validate-plan.test.ts",
  "src/queries/project/read-project-status.test.ts",
  "src/queries/project/show-project-graph.test.ts",
  "src/queries/system/read-status.test.ts",
  "src/services/event/atomicity.test.ts",
  "src/services/plan/sqlite.test.ts",
  "src/services/storage/migration-0002-graph-and-plan.test.ts",
  "src/services/storage/migration-0008-graph-indexes.test.ts",
];

const vendorPackages = [
  "koa",
  "@koa/*",
  "hono",
  "hono/*",
  "@hono/*",
  "commander",
  "convict",
  ...gitLibraries,
  "graphology",
  "pino",
  "supertest",
];

const removalPaths = [
  {
    name: "node:fs",
    importNames: [
      "default",
      "rm",
      "rmSync",
      "rmdir",
      "rmdirSync",
      "unlink",
      "unlinkSync",
    ],
    message:
      "removal has one chokepoint: take the resource and let resources.ts release it.",
  },
  {
    name: "node:fs/promises",
    importNames: ["default", "rm", "rmdir", "unlink"],
    message:
      "removal has one chokepoint: take the resource and let resources.ts release it.",
  },
];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".data/**",
      "src/**/__fixtures__/**",
    ],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { boundaries },
    settings: {
      // First match wins. http/contract precedes http/server precedes nothing;
      // src/* stays last so a new top-level directory is caught, not absorbed.
      "boundaries/elements": [
        { type: "domain", pattern: "src/domain", partialMatch: false },
        {
          type: "service",
          pattern: "src/services/*",
          capture: ["capability"],
          partialMatch: false,
        },
        { type: "command", pattern: "src/commands", partialMatch: false },
        { type: "query", pattern: "src/queries", partialMatch: false },
        {
          type: "http-contract",
          pattern: "src/http/contract",
          partialMatch: false,
        },
        {
          type: "http-server",
          pattern: "src/http/server",
          partialMatch: false,
        },
        { type: "cli", pattern: "src/cli", partialMatch: false },
        { type: "test-helper", pattern: "test/helpers", partialMatch: false },
      ],
      "boundaries/files": [
        { category: "service-interface", pattern: "src/services/*/index.ts" },
        { category: "composition-root", pattern: "src/main.ts" },
        {
          category: "test",
          pattern: ["src/**/*.test.ts", "test/**/*.test.ts"],
        },
      ],
    },
    rules: {
      // A seventh top-level directory is a decision, not an accident.
      "boundaries/no-unknown-files": 2,
      "boundaries/no-unknown-dependencies": 2,
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            // main.ts wires everything: the only importer of an implementation.
            {
              from: { file: { categories: "composition-root" } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "domain",
                        "service",
                        "command",
                        "query",
                        "http-contract",
                        "http-server",
                        "cli",
                      ],
                    },
                  },
                },
              },
            },
            // domain/ is pure and closed.
            {
              from: { element: { types: "domain" } },
              allow: { to: { element: { types: "domain" } } },
            },
            // A service reaches domain types and another capability's interface.
            {
              from: { element: { types: "service" } },
              allow: { to: { element: { types: "domain" } } },
            },
            {
              from: { element: { types: "service" } },
              allow: {
                to: {
                  element: { types: "service" },
                  file: { categories: "service-interface" },
                },
              },
            },
            // Business logic names an interface, never an implementation.
            {
              from: { element: { types: { anyOf: ["command", "query"] } } },
              allow: { to: { element: { types: "domain" } } },
            },
            {
              from: { element: { types: { anyOf: ["command", "query"] } } },
              allow: {
                to: {
                  element: { types: "service" },
                  file: { categories: "service-interface" },
                },
              },
            },
            // The transport contract is shared with the CLI, so it stays thin.
            {
              from: { element: { types: "http-contract" } },
              allow: {
                to: {
                  element: { types: { anyOf: ["domain", "http-contract"] } },
                },
              },
            },
            // The server calls one command or query per handler.
            {
              from: { element: { types: "http-server" } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "domain",
                        "command",
                        "query",
                        "http-contract",
                        "http-server",
                      ],
                    },
                  },
                },
              },
            },
            // The CLI is a typed client of the contract, on a second machine.
            {
              from: { element: { types: "cli" } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ["domain", "http-contract", "cli"] },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
  {
    // The git service runs the git binary: no wrapper library may return, and
    // the launcher is the only place a process is created. Flat config applies
    // the last no-restricted-imports entry per file, so the scoped blocks below
    // (which come after this one) win for their directories and carry their own
    // complete restriction sets; this one governs every other non-test src file.
    files: ["src/**/*.ts"],
    ignores: ["src/services/git/launcher.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: gitLibraries,
              message:
                "the git service runs the git binary through spawn; see docs/proposal/phase-1/git-foundation.md",
            },
            {
              group: ["node:child_process"],
              message:
                "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",
            },
            {
              group: ["koa", "@koa/*"],
              message:
                "the transport runs on hono; see docs/proposal/phase-1/transport.md",
            },
          ],
        },
      ],
    },
  },
  {
    // domain/ is pure: no node builtins, and zod is its one runtime dependency.
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: ["node:*", "ulid", "yaml", ...vendorPackages],
              message: "domain/ is pure: domain/ and zod only.",
            },
          ],
        },
      ],
    },
  },
  {
    // Business logic names no vendor package. It talks to service interfaces.
    files: ["src/commands/**/*.ts", "src/queries/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: [
                ...vendorPackages,
                "yaml",
                "node:sqlite",
                "node:fs",
                "node:fs/*",
                "node:http",
                "node:child_process",
              ],
              message:
                "commands/ and queries/ reach a capability through its service interface.",
            },
          ],
        },
      ],
    },
  },
  {
    // The transport contract is shared with the CLI, so it carries no server.
    files: ["src/http/contract/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: [
                "koa",
                "@koa/*",
                "hono",
                "hono/*",
                "@hono/*",
                "node:http",
                "node:sqlite",
                "node:child_process",
              ],
              message:
                "http/contract/ is the shared route contract: schemas only, no server.",
            },
          ],
        },
      ],
    },
  },
  {
    // The transport core imports no node:buffer. The global Buffer survives in
    // idempotency-key.ts and idempotency-store.ts until EPIC 035.
    // src/http/server/koa-body.ts is the one adapter that converts a HandlerResult
    // to a Koa body, and EPIC 032 deletes it. This block repeats the src/**/*.ts
    // restrictions because flat config applies the last no-restricted-imports
    // entry per file.
    files: ["src/http/server/**/*.ts"],
    ignores: ["src/http/server/koa-body.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: ["node:buffer"],
              message:
                "http/server/ is Fetch-native: use TextEncoder and Uint8Array; see docs/proposal/phase-1/transport.md",
            },
            {
              group: gitLibraries,
              message:
                "the git service runs the git binary through spawn; see docs/proposal/phase-1/git-foundation.md",
            },
            {
              group: ["node:child_process"],
              message:
                "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",
            },
          ],
        },
      ],
    },
  },
  {
    // The CLI runs on a second machine. It owns no daemon capability.
    files: ["src/cli/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: [
                "koa",
                "@koa/*",
                "hono",
                "hono/*",
                "@hono/*",
                "node:sqlite",
                "graphology",
                "node:child_process",
                ...gitLibraries,
              ],
              message:
                "cli/ calls the HTTP API. main.ts injects the db migrate handler.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.ts", "src/services/git/launcher.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          patterns: [
            {
              group: gitLibraries,
              message:
                "the git service runs the git binary through spawn; see docs/proposal/phase-1/git-foundation.md",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: nodeEdgeWriteExemptions,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${nodeEdgeWritePattern}/i]`,
          message: nodeEdgeWriteMessage,
        },
        {
          selector: `TemplateElement[value.raw=/${nodeEdgeWritePattern}/i]`,
          message: nodeEdgeWriteMessage,
        },
      ],
    },
  },
  {
    // A test reaches the implementation it covers, so dependency direction is
    // relaxed. It still never imports the composition root.
    files: ["src/**/*.test.ts", "test/**/*.ts"],
    rules: {
      "boundaries/dependencies": [
        2,
        {
          default: "allow",
          policies: [
            {
              from: { file: { categories: "test" } },
              disallow: { to: { file: { categories: "composition-root" } } },
            },
            {
              from: { element: { types: "test-helper" } },
              disallow: { to: { file: { categories: "composition-root" } } },
            },
          ],
        },
      ],
    },
  },
  {
    // The end-to-end harness is an out-of-tree consumer, not production code.
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    // Removal has one chokepoint. Three modules may remove: resources.ts (every
    // tree, through the ledger), driver/** (a driver owns the host it drives) and
    // secret-file.ts (one unlink, in its own release closure). Everything else
    // reaches removal through resources.ts. The ban is by imported NAME, not by
    // module — the harness reads the file system legitimately — and importNames
    // matches the imported binding, so `import { rm as removeTree }` is caught,
    // which is the rename a text scan misses.
    // `scenario/**` is excluded here and carries its own block below. Flat config
    // resolves a rule by LAST WINS per rule name, never by union, so two blocks
    // both naming `no-restricted-imports` over overlapping globs would leave only
    // the later one in force. The two globs are therefore disjoint, and the
    // scenario block repeats these entries rather than adding to them.
    files: ["scripts/e2e/lib/**/*.ts"],
    ignores: [
      "scripts/e2e/lib/**/*.test.ts",
      "scripts/e2e/lib/scenario/**/*.ts",
      "scripts/e2e/lib/resources.ts",
      "scripts/e2e/lib/secret-file.ts",
      "scripts/e2e/lib/driver/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [2, { paths: removalPaths }],
    },
  },
  {
    // A scenario removes nothing and spawns nothing. It repeats the removal
    // entries because of the last-wins rule described above.
    files: ["scripts/e2e/lib/scenario/**/*.ts"],
    ignores: ["scripts/e2e/lib/scenario/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        2,
        {
          paths: [
            ...removalPaths,
            {
              name: "node:child_process",
              message:
                "a scenario spawns nothing: command execution reaches it through the driver.",
            },
          ],
        },
      ],
    },
  },
];
