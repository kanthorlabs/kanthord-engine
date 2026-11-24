import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const KERNEL = "src/kernel/";
const RUNTIME_MODULES = [
  "src/agent/agent-contract.ts",
  "src/agent/agent-session.ts",
  "src/agent/bash-process.ts",
  "src/agent/catalog.ts",
  "src/agent/environment.ts",
  "src/agent/hooks/assistant-redaction.ts",
  "src/agent/hooks/checkout-confinement.ts",
  "src/agent/hooks/home-relative-cwd.ts",
  "src/agent/hooks/input-redaction.ts",
  "src/agent/hooks/marker-restore.ts",
  "src/agent/hooks/output-finding.ts",
  "src/agent/hooks/pinned-layers.ts",
  "src/agent/hooks/tool-allowlist.ts",
  "src/agent/pi-tools.ts",
  "src/agent/pi.ts",
  "src/agent/pinned-layers.ts",
  "src/agent/prompt-assets.ts",
  "src/agent/prompt-chain.ts",
  "src/agent/redaction.ts",
  "src/agent/run-budget.ts",
  "src/agent/run-outcome.ts",
  "src/agent/sensitive-text.ts",
  "src/agent/start-preconditions.ts",
  "src/agent/tool-table.ts",
];
const SERVICE_CONTRACTS = ["src/scheduler/contract.ts"];
const PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "zod",
];
const REFUSED_IDENTIFIERS = ["setGlobalDispatcher", "EnvHttpProxyAgent"];
const BUILTINS = new Set(builtinModules);

function specifiersOf(file) {
  const source = readFileSync(join(ROOT, file), "utf8");
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((entry) => entry.fileName);
}

function isPackageAllowed(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (BUILTINS.has(specifier.split("/")[0])) return true;
  return PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

const ALLOWED_MODULES = new Set([...RUNTIME_MODULES, ...SERVICE_CONTRACTS]);

function closureViolations(entries) {
  const seen = new Set();
  const pending = [...entries];
  const violations = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (!specifier.startsWith(".")) {
        if (!isPackageAllowed(specifier))
          violations.push(`${file} imports ${specifier}`);
        continue;
      }
      const target = relative(ROOT, resolve(ROOT, dirname(file), specifier));
      if (target.startsWith(KERNEL)) continue;
      if (!ALLOWED_MODULES.has(target)) {
        violations.push(`${file} imports ${target}`);
        continue;
      }
      pending.push(target);
    }
  }
  return violations;
}

test("the import closure of each runtime module stays in the allowed set", () => {
  const violations = closureViolations(RUNTIME_MODULES);
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the import check refuses a runtime import outside the allowed set", () => {
  assert.deepEqual(closureViolations(["src/agent/known-secrets.ts"]), [
    "src/agent/known-secrets.ts imports src/custody/contract.ts",
  ]);
});

test("no runtime module names setGlobalDispatcher or EnvHttpProxyAgent", () => {
  const violations = RUNTIME_MODULES.flatMap((file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    return REFUSED_IDENTIFIERS.filter((name) => source.includes(name)).map(
      (name) => `${file} names ${name}`,
    );
  });
  assert.deepEqual(violations, [], violations.join("\n"));
});
