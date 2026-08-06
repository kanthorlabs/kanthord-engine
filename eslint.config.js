// Import-boundary enforcement for the six-directory architecture (AGENTS.md).
// Elements classify folders; `boundaries/files` classifies the two files that
// carry a rule of their own — a service interface, and the composition root.
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

const gitLibraries = ["isomorphic-git", "simple-git", "nodegit"];

const vendorPackages = [
  "koa",
  "@koa/*",
  "commander",
  "convict",
  ...gitLibraries,
  "graphology",
  "pino",
  "supertest",
];

export default [
  {
    ignores: ["node_modules/**", ".data/**", "src/**/__fixtures__/**"],
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
                "only src/services/git/launcher.ts creates a process; see .agent/plan/stories/006-git-primitives/04-supervised-spawn.md",
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
];
