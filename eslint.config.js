// Import-boundary enforcement for the hexagonal architecture (AGENTS.md).
// Encodes the four import directions as dependency policies:
//   1. domain/ imports nothing outside domain/
//   2. app/ imports only domain/ + */port.ts
//   3. only main.ts imports concrete adapters
//   4. apps/ never imports adapters or domain internals
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default [
  {
    ignores: ["node_modules/**", ".data/**", "src/**/__fixtures__/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { boundaries },
    settings: {
      // First match wins — domain/app/apps before the capability catch-all.
      "boundaries/elements": [
        { type: "domain", pattern: "src/domain", partialMatch: false },
        { type: "app", pattern: "src/app", partialMatch: false },
        { type: "apps", pattern: "src/apps", partialMatch: false },
        // Any other top-level dir under src/ is a capability (adapter layer),
        // e.g. src/storage. main.ts stays unclassified (composition root).
        { type: "adapter", pattern: "src/*", partialMatch: false },
      ],
      "boundaries/files": [
        { category: "test", pattern: "src/**/*.test.ts" },
        { category: "port", pattern: "src/*/port.ts" },
        { category: "composition-root", pattern: "src/main.ts" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            // main.ts wires everything: the only importer of concrete adapters.
            {
              from: { file: { categories: "composition-root" } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ["domain", "app", "apps", "adapter"] },
                  },
                },
              },
            },
            // domain/ imports only domain/.
            {
              from: { element: { types: "domain" } },
              allow: { to: { element: { types: "domain" } } },
            },
            // app/ imports domain/ and */port.ts — never a concrete adapter.
            {
              from: { element: { types: "app" } },
              allow: { to: { element: { types: "domain" } } },
            },
            {
              from: { element: { types: "app" } },
              allow: {
                to: {
                  element: { types: "adapter" },
                  file: { categories: "port" },
                },
              },
            },
            // apps/ calls use cases only — no adapters, no domain internals.
            {
              from: { element: { types: "apps" } },
              allow: { to: { element: { types: "app" } } },
            },
            // adapters import their own port + sibling adapters + domain types.
            {
              from: { element: { types: "adapter" } },
              allow: {
                to: { element: { types: { anyOf: ["adapter", "domain"] } } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    // Test carve-out: tests import node:test/assert and (co-located) adapters.
    files: ["src/**/*.test.ts"],
    rules: { "boundaries/dependencies": "off" },
  },
];
