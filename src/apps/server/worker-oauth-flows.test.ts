import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { stopAfter, temporary } from "../../kernel/test-support.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE_ACCESS = "fake-access-token";
const PROVIDERS = ["anthropic", "openai-codex", "github-copilot"];
const BUNDLE_DIRECTORY = join(ENGINE_ROOT, "release", "bundle");
const ENTRY = `
import { parentPort } from "node:worker_threads";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { WorkerUnit } from "./src/apps/worker/unit.ts";

async function main() {
  new WorkerUnit({ bindings: [], directories: { data: "", log: "" }, env: process.env, log: () => {} });
  const credential = {
    type: "oauth",
    access: ${JSON.stringify(FAKE_ACCESS)},
    refresh: "fake-refresh-token",
    expires: Date.now() + 3600000,
  };
  const providers = [anthropicProvider(), openaiCodexProvider(), githubCopilotProvider()];
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.auth.oauth.toAuth(credential)),
  );
  const report = settled.map((result, index) => ({
    provider: providers[index].id,
    api_key: result.status === "fulfilled" ? result.value.apiKey : undefined,
    error: result.status === "rejected" ? String(result.reason?.message ?? result.reason) : undefined,
  }));
  if (parentPort) parentPort.postMessage(report);
  else process.stdout.write(JSON.stringify(report));
}

void main();
`;

interface Derivation {
  provider: string;
  api_key?: string;
  error?: string;
}

async function bundle(name: string): Promise<string> {
  const location = JSON.stringify(join(BUNDLE_DIRECTORY, name));
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: ENGINE_ROOT, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    write: false,
    logLevel: "silent",
    banner: {
      js: `const __kanthord_import_meta_url=require('node:url').pathToFileURL(${location}).href;`,
    },
    define: { "import.meta.url": "__kanthord_import_meta_url" },
  });
  return result.outputFiles[0]!.text;
}

function assertDerived(report: Derivation[]): void {
  assert.deepEqual(
    report.map(({ provider, api_key, error }) => ({
      provider,
      api_key,
      error,
    })),
    PROVIDERS.map((provider) => ({
      provider,
      api_key: FAKE_ACCESS,
      error: undefined,
    })),
  );
}

test("the release bundle of a worker unit derives OAuth auth in an eval worker thread", async (t) => {
  const thread = new Worker(await bundle("worker-thread.cjs"), {
    eval: true,
    env: { HOME: temporary(t) },
  });
  stopAfter(t, () => thread.terminate());
  const [report] = (await once(thread, "message")) as [Derivation[]];
  assertDerived(report);
});

test("the release bundle of a worker unit derives OAuth auth in a main process", async (t) => {
  const root = temporary(t);
  const path = join(root, "kanthord.cjs");
  writeFileSync(path, await bundle("kanthord.cjs"));
  const { stdout } = await promisify(execFile)(process.execPath, [path], {
    cwd: root,
    env: { HOME: root },
  });
  assertDerived(JSON.parse(stdout) as Derivation[]);
});
