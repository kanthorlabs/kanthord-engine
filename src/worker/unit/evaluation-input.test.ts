import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import type { Evidence } from "../../mission/contract.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  anthropicSetup,
  repositorySetup,
  TEST_SSH_HOST_KEY,
  TEST_SSH_PUBLIC_KEY,
  everyBindingSshAccess,
  transport as localTransport,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { ExecutionIntent } from "../contract.ts";
import {
  CHECKOUTS_DIRECTORY,
  EVIDENCE_DIRECTORY,
  WorkspaceRoot,
  WorkspaceKind,
} from "./workspace.ts";
import type { RepositoryTransport } from "../contract.ts";
import {
  snapshotOf,
  placedOf,
  prepareEvaluation,
  verificationCommands,
} from "./evaluation-input.ts";

test("snapshot selection excludes requests and verifications and orders by identity", () => {
  const asset = {
    kind: "repository",
    address: { kind: "repository", binding_id: "binding", commit: "head" },
  };
  const evidence = [
    { id: "a", assets: [asset] },
    { id: "b", assets: [asset] },
    { id: "c", assets: [asset], requirement_key: "request" },
    { id: "d", assets: [asset], verification: {} },
  ] as Evidence[];
  assert.deepEqual(snapshotOf(evidence, "binding"), {
    evidenceId: "b",
    commit: "head",
  });
  assert.equal(snapshotOf(evidence, "other"), null);
  assert.equal(placedOf(evidence), null);
});

test("B3 review bundle places all supporting assets in the evidence directory outside the checkouts and removes partial object failures", async (t) => {
  for (const mode of ["success", "failure", "cancel"] as const) {
    const setup = anthropicSetup();
    const repository = {
      binding_id: createIdentity("binding"),
      name: "repo",
      address: "git@github.com:owner/repo.git",
      ssh_host_key: TEST_SSH_HOST_KEY,
      ssh_public_key: TEST_SSH_PUBLIC_KEY,
      strategy: { base_branch: "main" },
      project_prompt: null,
      working_layer: WORKING_LAYER_ALL_ON,
    };
    setup.repositories = [
      repository,
      { ...repository, binding_id: createIdentity("binding"), name: "other" },
    ];
    const claim = {
      execution_id: setup.execution_id,
      node_id: createIdentity("node"),
      attempt: 1,
      pinned_revision: 1,
      node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    };
    const first = createIdentity("evidence_asset");
    const second = createIdentity("evidence_asset");
    const produced = { kind: "produced", sha256: "a".repeat(64) };
    const object = { kind: "object", location: "s3://test/report" };
    const evidence = [
      {
        id: "support",
        assets: [
          { id: first, kind: "produced", address: produced },
          { id: second, kind: "object", address: object },
        ],
      },
    ] as Evidence[];
    const SUCCESS = "success";
    const CANCEL = "cancel";
    const server = createServer((_request, response) => {
      if (mode === CANCEL) {
        run.operationContext.cancel();
        return;
      }
      response.writeHead(mode === SUCCESS ? 200 : 500);
      response.end("object report");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private-get`;
    const clients = {
      mission: {
        "execution.evidence.asset.content.get": async (input: {
          params: { asset_id: string };
        }) => ({
          type: "completed",
          status: 200,
          data:
            input.params.asset_id === first
              ? {
                  asset_id: first,
                  address: produced,
                  data: Buffer.from("inline report").toString("base64"),
                  encoding: "base64",
                  media_type: "text/plain",
                }
              : {
                  asset_id: second,
                  address: object,
                  get_url: url,
                  size: 13,
                  media_type: "text/plain",
                  expires_at: Date.now() + 60000,
                },
        }),
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: { release: async () => {} },
      context: background,
    });
    const workspaces = WorkspaceRoot.open(temporary(t));
    const transport = {
      cloneSnapshot: async () => "a".repeat(40),
    } as unknown as RepositoryTransport;
    try {
      const pending = prepareEvaluation(
        {
          setup,
          claim,
          workspaces,
          transport,
          sshAccess: everyBindingSshAccess,
          env: hostEnvironment(),
        },
        run,
        ExecutionIntent.Examine,
        evidence,
      );
      if (mode !== SUCCESS) {
        await assert.rejects(pending);
        assert.equal(
          existsSync(workspaces.executionKey(claim.execution_id)),
          false,
        );
        continue;
      }
      const result = await pending;
      assert.deepEqual(result.evidenceIds, ["support"]);
      const ASSET_REVIEW_COUNT = 2;
      assert.equal(result.reviewBundle.assets.length, ASSET_REVIEW_COUNT);
      assert.deepEqual(result.reviewBundle.added_files, []);
      assert.equal(
        (result.tested_input as unknown[]).length,
        ASSET_REVIEW_COUNT,
      );
      assert.equal(JSON.stringify(result).includes(url), false);
      assert.equal(
        result.directory,
        join(workspaces.executionKey(claim.execution_id), CHECKOUTS_DIRECTORY),
      );
      const evidenceDirectory = join(result.key, EVIDENCE_DIRECTORY);
      assert.deepEqual(
        result.reviewBundle.assets.map((item) => item.path).sort(),
        [first, second].map((id) => join("..", EVIDENCE_DIRECTORY, id)).sort(),
      );
      const OBJECT_REPORT = "object report";
      assert.equal(
        readFileSync(join(evidenceDirectory, second), "utf8"),
        OBJECT_REPORT,
      );
      assert.equal(existsSync(join(result.directory, second)), false);
      workspaces.release(result.key, WorkspaceKind.Execution);
    } finally {
      run.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("an examine node with no binding places the produced evidence privately and preserves command order", async (t) => {
  const setup = anthropicSetup({ repositories: [] });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const evidence = [
    { id: "evidence", assets: [{ id: assetId, kind: "produced", address }] },
  ] as Evidence[];
  const clients = {
    mission: {
      "execution.evidence.asset.content.get": async () => ({
        type: "completed",
        status: 200,
        data: {
          asset_id: assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        },
      }),
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspaces = WorkspaceRoot.open(temporary(t));
  const prepared = await prepareEvaluation(
    {
      setup,
      claim,
      workspaces,
      transport: {} as RepositoryTransport,
      sshAccess: everyBindingSshAccess,
      env: hostEnvironment(),
    },
    run,
    ExecutionIntent.Examine,
    evidence,
  );
  assert.deepEqual(prepared.tested_input, address);
  const REPORT = "report";
  const PRIVATE = 0o600;
  assert.equal(readFileSync(join(prepared.directory, assetId), "utf8"), REPORT);
  assert.equal(
    statSync(join(prepared.directory, assetId)).mode & 0o777,
    PRIVATE,
  );
  assert.equal(prepared.directory, prepared.key);
  workspaces.release(prepared.key, WorkspaceKind.Execution);
  const content = {
    name: "name",
    requirement: "requirement",
    criterion: "criterion",
    bindings: [],
    verifications: ["node"],
  };
  assert.deepEqual(
    verificationCommands({
      content: { ...content, intent: ExecutionIntent.Implement, tags: [] },
      tasks: [
        {
          id: "task",
          filename: "task.md",
          content: { ...content, verifications: ["task"] },
        },
      ],
    }),
    ["node", "task"],
  );
});

const PLACED_REPORT = "placed report";
const ADDED_FILE = "added.md";

test("an examine node with one binding places the produced evidence outside its clean checkout", async (t) => {
  const setup = anthropicSetup({ repositories: [repositorySetup()] });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const evidence = [
    { id: "evidence", assets: [{ id: assetId, kind: "produced", address }] },
  ] as Evidence[];
  const clients = {
    mission: {
      "execution.evidence.asset.content.get": async () => ({
        type: "completed",
        status: 200,
        data: {
          asset_id: assetId,
          address,
          data: Buffer.from(PLACED_REPORT).toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        },
      }),
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspaces = WorkspaceRoot.open(temporary(t));
  const prepared = await prepareEvaluation(
    {
      setup,
      claim,
      workspaces,
      transport: {
        cloneSnapshot: async () => "a".repeat(40),
      } as unknown as RepositoryTransport,
      sshAccess: everyBindingSshAccess,
      env: hostEnvironment(),
    },
    run,
    ExecutionIntent.Examine,
    evidence,
  );
  assert.equal(
    prepared.directory,
    join(prepared.key, CHECKOUTS_DIRECTORY, setup.repositories[0]!.name),
  );
  assert.deepEqual(readdirSync(prepared.directory), []);
  assert.equal(
    readFileSync(join(prepared.key, EVIDENCE_DIRECTORY, assetId), "utf8"),
    PLACED_REPORT,
  );
  assert.deepEqual(
    prepared.reviewBundle.assets.map((item) => item.path),
    [join("..", "..", EVIDENCE_DIRECTORY, assetId)],
  );
  workspaces.release(prepared.key, WorkspaceKind.Execution);
});

test("an implement snapshot evaluation places the produced evidence outside its clean checkout", async (t) => {
  const state = temporary(t);
  const origin = join(state, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  const commit = async (name: string) => {
    writeFileSync(join(origin, name), name);
    await git.add(name);
    await git.raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      name,
    ]);
    return (await git.revparse(["HEAD"])).trim();
  };
  await commit("base");
  await git.raw(["checkout", "-b", "node"]);
  const snapshot = await commit(ADDED_FILE);
  await git.raw(["checkout", "main"]);
  const repository = { ...repositorySetup(), address: origin };
  const setup = anthropicSetup({
    intent: ExecutionIntent.Implement,
    repositories: [repository],
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const evidence = [
    {
      id: "evidence_1",
      assets: [
        {
          id: createIdentity("evidence_asset"),
          kind: "repository",
          address: {
            kind: "repository",
            binding_id: repository.binding_id,
            commit: snapshot,
          },
        },
      ],
    },
    { id: "evidence_2", assets: [{ id: assetId, kind: "produced", address }] },
  ] as Evidence[];
  const clients = {
    mission: {
      "execution.evidence.asset.content.get": async () => ({
        type: "completed",
        status: 200,
        data: {
          asset_id: assetId,
          address,
          data: Buffer.from(PLACED_REPORT).toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        },
      }),
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspaces = WorkspaceRoot.open(join(state, "workspaces"));
  const prepared = await prepareEvaluation(
    {
      setup,
      claim,
      workspaces,
      transport: localTransport,
      sshAccess: everyBindingSshAccess,
      env: hostEnvironment(),
    },
    run,
    ExecutionIntent.Implement,
    evidence,
  );
  assert.equal(
    prepared.directory,
    join(prepared.key, CHECKOUTS_DIRECTORY, repository.name),
  );
  assert.equal(
    (await simpleGit(prepared.directory).revparse(["HEAD"])).trim(),
    snapshot,
  );
  assert.deepEqual((await simpleGit(prepared.directory).status()).files, []);
  assert.equal(existsSync(join(prepared.directory, assetId)), false);
  assert.deepEqual(prepared.tested_input, {
    kind: "repository",
    binding_id: repository.binding_id,
    commit: snapshot,
  });
  assert.equal(
    readFileSync(join(prepared.key, EVIDENCE_DIRECTORY, assetId), "utf8"),
    PLACED_REPORT,
  );
  assert.deepEqual(
    prepared.reviewBundle.assets.map((item) => item.path),
    [join("..", "..", EVIDENCE_DIRECTORY, assetId)],
  );
  assert.deepEqual(prepared.reviewBundle.added_files, [ADDED_FILE]);
  workspaces.release(prepared.key, WorkspaceKind.Execution);
  assert.equal(existsSync(prepared.key), false);
});

async function snapshotOrigin(state: string, name: string) {
  const origin = join(state, `${name}-origin`);
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  const commit = async (file: string) => {
    writeFileSync(join(origin, file), file);
    await git.add(file);
    await git.raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      file,
    ]);
    return (await git.revparse(["HEAD"])).trim();
  };
  await commit("base");
  await git.raw(["checkout", "-b", "node"]);
  const snapshot = await commit(`${name}.md`);
  await git.raw(["checkout", "main"]);
  return {
    repository: { ...repositorySetup(), name, address: origin },
    snapshot,
  };
}

async function twoBindingEvaluation(t: test.TestContext, names: string[]) {
  const state = temporary(t);
  const api = await snapshotOrigin(state, "api");
  const web = await snapshotOrigin(state, "web");
  const setup = anthropicSetup({
    intent: ExecutionIntent.Implement,
    repositories: [api.repository, web.repository],
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const evidence = [
    {
      id: "evidence_1",
      assets: [api, web]
        .filter(({ repository }) => names.includes(repository.name))
        .map(({ repository, snapshot }) => ({
          id: createIdentity("evidence_asset"),
          kind: "repository",
          address: {
            kind: "repository",
            binding_id: repository.binding_id,
            commit: snapshot,
          },
        })),
    },
  ] as Evidence[];
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspaces = WorkspaceRoot.open(join(state, "workspaces"));
  const pending = prepareEvaluation(
    {
      setup,
      claim,
      workspaces,
      transport: localTransport,
      sshAccess: everyBindingSshAccess,
      env: hostEnvironment(),
    },
    run,
    ExecutionIntent.Implement,
    evidence,
  );
  return { pending, workspaces, claim, checkouts: [api, web] };
}

test("two bindings check out two snapshots and record one tested commit for each", async (t) => {
  const h = await twoBindingEvaluation(t, ["api", "web"]);
  const prepared = await h.pending;
  assert.equal(prepared.directory, join(prepared.key, CHECKOUTS_DIRECTORY));
  for (const { repository, snapshot } of h.checkouts) {
    const directory = join(prepared.directory, repository.name);
    assert.equal(
      (await simpleGit(directory).revparse(["HEAD"])).trim(),
      snapshot,
    );
    assert.deepEqual((await simpleGit(directory).status()).files, []);
  }
  assert.deepEqual(
    prepared.tested_input,
    h.checkouts.map(({ repository, snapshot }) => ({
      kind: "repository",
      binding_id: repository.binding_id,
      commit: snapshot,
    })),
  );
  assert.deepEqual(prepared.evidenceIds, ["evidence_1"]);
  assert.deepEqual(prepared.reviewBundle.added_files, [
    join("api", "api.md"),
    join("web", "web.md"),
  ]);
  h.workspaces.release(prepared.key, WorkspaceKind.Execution);
});

test("a snapshot that misses a binding stops with operation_failed", async (t) => {
  const h = await twoBindingEvaluation(t, ["api"]);
  await assert.rejects(
    h.pending,
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.OperationFailed,
  );
  assert.equal(
    existsSync(h.workspaces.executionKey(h.claim.execution_id)),
    false,
  );
});
