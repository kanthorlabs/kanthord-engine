import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { executionSetup } from "./execution-setup.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import { PROMPT_SOURCE_MAX_BYTES } from "../agent/prompt-source.ts";
import { anthropicSetup } from "./test-support.ts";
import { WorkerErrorCode } from "./contract.ts";

const SSH_CREDENTIAL = "kanthorlabs-ssh";

test("setup resolves configured global files before its single snapshot and supports a pinned entry", async (t) => {
  const dataDirectory = temporary(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const setup = anthropicSetup();
  const entry = {
    agent: setup.agentName,
    agentProvider: "default",
    modelIdentifier: setup.effectiveConfiguration.modelIdentifier,
    reasoningEffort: "low",
  };
  const config = { globalPrompt: "", heartbeatWindow: 60000 };
  let commits = 0;
  const claim = {
    executionId: setup.executionId,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    attempt: 1,
    projectId: createIdentity("project"),
  };
  const caller: CallerContext = {
    identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
    context: background,
    requestId: "request",
    execution: claim,
    commit: (fn) => {
      commits++;
      return store.transaction(fn);
    },
  };
  const dependencies = {
    config,
    dataDirectory,
    workerBindingRowOf: () => ({
      bindingId: claim.workerBindingId,
      projectId: claim.projectId,
      resourceIdentity: "worker:general@1",
      tombstone: false,
      disabled: false,
      workerName: setup.workerName,
      entries: [entry],
      resourceBudget: null,
    }),
    pinnedCredentialMetadata: () => ({
      id: setup.credentialId,
      name: setup.effectiveConfiguration.credential,
      platform: setup.effectiveConfiguration.provider,
      metadata: null,
    }),
    repositoryBindingIdsOf: () => [],
    repositoryPolicyOf: () => null,
    credentialMetadata: () => null,
  };
  const worker = {
    declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
    workerAgentView: (
      ...args: Parameters<
        import("./service.ts").WorkerService["workerAgentView"]
      >
    ) => {
      assert.deepEqual(args[3], {
        agentProvider: entry.agentProvider,
        modelIdentifier: entry.modelIdentifier,
        reasoningEffort: entry.reasoningEffort,
      });
      assert.ok(args[4]);
      return {
        defaults: null,
        effective: {
          ...setup.effectiveConfiguration,
          reasoningEffort: entry.reasoningEffort,
        },
        valid: true,
        issues: [],
      };
    },
  };
  writeFileSync(join(dataDirectory, "-"), "literal dash file");
  writeFileSync(join(dataDirectory, "prompt.md"), "configured global");
  writeFileSync(
    join(dataDirectory, "large.md"),
    "x".repeat(PROMPT_SOURCE_MAX_BYTES + 1),
  );
  for (const [value, expected] of [
    ["", { state: "absent" }],
    ["-", { state: "disabled" }],
    [
      "./-",
      {
        state: "present",
        path: join(dataDirectory, "-"),
        text: "literal dash file",
      },
    ],
    [
      "prompt.md",
      {
        state: "present",
        path: join(dataDirectory, "prompt.md"),
        text: "configured global",
      },
    ],
    [
      "large.md",
      {
        state: "invalid",
        path: join(dataDirectory, "large.md"),
        reason: "too_large",
      },
    ],
  ] as const) {
    config.globalPrompt = value;
    const before = commits;
    const answer = await executionSetup(dependencies, worker, caller);
    assert.deepEqual(answer.globalPrompt, expected);
    assert.equal(
      answer.effectiveConfiguration.reasoningEffort,
      entry.reasoningEffort,
    );
    assert.equal(commits, before + 1);
  }
  await assert.rejects(
    executionSetup(
      dependencies,
      { ...worker, declarationOf: () => getWorkerDeclaration("claude@1")! },
      caller,
    ),
    (error) =>
      error instanceof OperationError &&
      error.code === WorkerErrorCode.ExecutionNoNativeAgent,
  );
  const bindingId = createIdentity("binding");
  const sshIdentity = {
    host: "kanthorlabs.github.com",
    hostname: "ssh.github.com",
    port: 443,
    identity_file: "~/.ssh/id_kanthorlabs",
  };
  const pinned = await executionSetup(
    {
      ...dependencies,
      repositoryBindingIdsOf: () => [bindingId],
      repositoryPolicyOf: () => ({
        bindingId,
        name: "repo",
        address: "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
        sshCredential: SSH_CREDENTIAL,
        baseBranch: "main",
        projectPrompt: null,
      }),
      credentialMetadata: (_tx, name) =>
        name === SSH_CREDENTIAL
          ? { platform: "ssh", metadata: sshIdentity }
          : null,
    },
    worker,
    caller,
  );
  assert.deepEqual(pinned.repositories[0]?.sshIdentity, sshIdentity);
});
