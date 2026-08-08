import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm as removeTree } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSecretFile } from "./secret-file.ts";
import { secrets } from "./redact.ts";
import { createLedger } from "./resources.ts";
import type { ScenarioContext } from "./scenario/context.ts";

function fakeContext(ledger: ReturnType<typeof createLedger>): ScenarioContext {
  return {
    tag: "secret-file-test",
    scenarioId: "P1-E4",
    bundleDirectory: "/tmp/secret-file-test-bundle",
    take: ledger.take,
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(): void {},
    daemonHost: null,
    clientHost: null,
  };
}

test("writeSecretFile writes mode 0600 regardless of umask, registers the value, and takes the file into the ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-secret-file-"));
  const path = join(directory, "token");
  const previousUmask = process.umask(0o000);

  try {
    const ledger = createLedger();
    const context = fakeContext(ledger);
    const value = "a-secret-value-12345";

    const result = await writeSecretFile(context, path, value);

    assert.equal(result, path);

    const stat = statSync(path);
    assert.equal(stat.mode & 0o777, 0o600);

    assert.equal(secrets.values().includes(value), true);

    assert.equal(
      ledger.taken().some((handle) => handle.id === path),
      true,
    );
  } finally {
    process.umask(previousUmask);
    await removeTree(directory, { recursive: true, force: true });
  }
});
