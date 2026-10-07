import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";

const ENGINE_ROOT = resolve(import.meta.dirname, "../../..");
const BOUNDARY_RULE = "boundaries/dependencies";
const REFUSED_PROBES = ["src/intake/probe.ts", "src/kernel/probe.ts"];
const ADMITTED_PROBE = "src/apps/server/probe.ts";
const EXPECTED_REFUSALS = 1;
const NO_REFUSALS = 0;

function probeSource(filePath: string): string {
  const specifier = filePath.startsWith("src/kernel/")
    ? "./service-mint.ts"
    : filePath.startsWith("src/apps/server/")
      ? "../../kernel/service-mint.ts"
      : "../kernel/service-mint.ts";
  return `import { mintServiceIdentity } from "${specifier}";\nexport const probe = mintServiceIdentity("intake");\n`;
}

async function boundaryErrors(filePath: string): Promise<number> {
  const eslint = new ESLint({ cwd: ENGINE_ROOT });
  const [result] = await eslint.lintText(probeSource(filePath), {
    filePath: resolve(ENGINE_ROOT, filePath),
  });
  assert.ok(result);
  return result.messages.filter((message) => message.ruleId === BOUNDARY_RULE)
    .length;
}

test("an import of service-mint.ts outside src/apps/server/ is a boundary error", async () => {
  for (const filePath of REFUSED_PROBES)
    assert.equal(await boundaryErrors(filePath), EXPECTED_REFUSALS, filePath);
});

test("an import of service-mint.ts from src/apps/server/ is admitted", async () => {
  assert.equal(await boundaryErrors(ADMITTED_PROBE), NO_REFUSALS);
});
