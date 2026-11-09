import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import type { Evidence } from "../../mission/contract.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  anthropicSetup,
  everyBindingSshAccess,
  transport as localTransport,
  repositorySetup,
  TEST_SSH_HOST_KEY,
  TEST_SSH_PUBLIC_KEY,
} from "./test-support.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { ExecutionIntent } from "../contract.ts";
import {
  CHECKOUTS_DIRECTORY,
  EVIDENCE_DIRECTORY,
  REVIEW_DIRECTORY,
  WorkspaceRoot,
} from "./workspace.ts";
import type { RepositoryTransport } from "../contract.ts";
import {
  placedOf,
  prepareEvaluation,
  snapshotOf,
  verificationCommands,
} from "./evaluation-input.ts";
import { CODER_REPORT_SUBJECT } from "./coder-report.ts";
import { ROUND_PATCH_SUBJECT } from "./round-patch.ts";

const FIRST_ROUND = {
  round: 1,
  final: false,
  review_base: null,
  findings: [],
};

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

test("an affected test evidence is no snapshot and no placed asset", () => {
  const assets = [
    {
      kind: "repository",
      address: { kind: "repository", binding_id: "binding", commit: "head" },
    },
    { kind: "produced", address: { kind: "produced", sha256: "a".repeat(64) } },
  ];
  const evidence = [
    { id: "z", subject: "Affected test results", assets },
  ] as Evidence[];
  assert.equal(snapshotOf(evidence, "binding"), null);
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
      resource_identity: "github:kanthorlabs/engine",
      ssh_public_key: TEST_SSH_PUBLIC_KEY,
      strategy: { base_branch: "main" },
      environment: null,
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
      {
        id: "affected",
        subject: "Affected test results",
        assets: [
          {
            id: createIdentity("evidence_asset"),
            kind: "produced",
            address: produced,
          },
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
        FIRST_ROUND,
      );
      if (mode !== SUCCESS) {
        await assert.rejects(pending);
        assert.equal(
          existsSync(join(workspaces.nodeKey(claim.node_id), REVIEW_DIRECTORY)),
          false,
        );
        continue;
      }
      const result = await pending;
      assert.deepEqual(result.evidenceIds, ["support"]);
      const ASSET_REVIEW_COUNT = 2;
      assert.equal(result.reviewBundle.assets.length, ASSET_REVIEW_COUNT);
      assert.deepEqual(result.reviewBundle.added_files, []);
      assert.deepEqual(result.reviewBundle.changed_files, []);
      assert.equal(
        (result.tested_input as unknown[]).length,
        ASSET_REVIEW_COUNT,
      );
      assert.equal(
        JSON.stringify({ ...result, base: null }).includes(url),
        false,
      );
      assert.equal(
        result.directory,
        join(
          workspaces.nodeKey(claim.node_id),
          REVIEW_DIRECTORY,
          CHECKOUTS_DIRECTORY,
        ),
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
      workspaces.release(result.key, result.kind);
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
  stopAfter(t, () => run.dispose());
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
    FIRST_ROUND,
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
  workspaces.release(prepared.key, prepared.kind);
  const content = {
    name: "name",
    requirement: "requirement",
    criterion: "criterion",
    bindings: [],
    verifications: ["node"],
  };
  assert.deepEqual(
    verificationCommands({
      content: {
        ...content,
        intent: ExecutionIntent.Implement,
        tags: [],
        external_links: [],
      },
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
const MODIFIED_FILE = "base";
const MODIFIED_CONTENT = "modified";

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
  stopAfter(t, () => run.dispose());
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
    FIRST_ROUND,
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
  workspaces.release(prepared.key, prepared.kind);
});

test("an implement snapshot evaluation places only the latest coder report outside its clean checkout", async (t) => {
  const state = temporary(t);
  const origin = join(state, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  const commit = async (name: string, content = name) => {
    writeFileSync(join(origin, name), content);
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
  await commit(MODIFIED_FILE, MODIFIED_CONTENT);
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
  const staleAssetId = createIdentity("evidence_asset");
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
    {
      id: "evidence_2",
      subject: CODER_REPORT_SUBJECT,
      assets: [{ id: staleAssetId, kind: "produced", address }],
    },
    {
      id: "evidence_3",
      subject: CODER_REPORT_SUBJECT,
      assets: [{ id: assetId, kind: "produced", address }],
    },
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
  stopAfter(t, () => run.dispose());
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
    FIRST_ROUND,
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
  assert.deepEqual(
    prepared.reviewBundle.evidence.map((item) => item.id),
    ["evidence_1", "evidence_3"],
  );
  assert.equal(
    existsSync(join(prepared.key, EVIDENCE_DIRECTORY, staleAssetId)),
    false,
  );
  assert.deepEqual(prepared.reviewBundle.added_files, [ADDED_FILE]);
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    ADDED_FILE,
    MODIFIED_FILE,
  ]);
  assert.deepEqual(Object.keys(prepared.reviewBundle), [
    "evidence",
    "assets",
    "added_files",
    "changed_files",
  ]);
  assert.deepEqual(prepared.patches, []);
  workspaces.release(prepared.key, prepared.kind);
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
  stopAfter(t, () => run.dispose());
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
    FIRST_ROUND,
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
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    join("api", "api.md"),
    join("web", "web.md"),
  ]);
  h.workspaces.release(prepared.key, prepared.kind);
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
    existsSync(join(h.workspaces.nodeKey(h.claim.node_id), REVIEW_DIRECTORY)),
    false,
  );
});

test("an old round patch evidence is no snapshot and no placed asset", () => {
  const evidence = [
    {
      id: "z",
      subject: ROUND_PATCH_SUBJECT,
      assets: [
        {
          kind: "produced",
          address: { kind: "produced", sha256: "a".repeat(64) },
        },
      ],
    },
  ] as Evidence[];
  assert.equal(placedOf(evidence), null);
});

const SINGLE_BINDING = 1;
const ONE_ENTRY = 1;
const OFF_HISTORY = "review base off the node history";
const COMMITTER = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

async function roundOrigin(state: string, name: string) {
  const origin = join(state, `${name}-origin`);
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  const commit = async (file: string, content = file) => {
    writeFileSync(join(origin, file), content);
    await git.add(file);
    await git.raw([...COMMITTER, "commit", "-m", file]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const remove = async (file: string) => {
    await git.raw(["rm", "-q", file]);
    await git.raw([...COMMITTER, "commit", "-m", `remove ${file}`]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const merge = async (branch: string, resolved?: Record<string, string>) => {
    if (resolved === undefined) {
      await git.raw([...COMMITTER, "merge", "--no-ff", "-m", "merge", branch]);
      return (await git.revparse(["HEAD"])).trim();
    }
    await git
      .raw([...COMMITTER, "merge", "--no-ff", "-m", "merge", branch])
      .catch(() => undefined);
    for (const [file, content] of Object.entries(resolved)) {
      writeFileSync(join(origin, file), content);
      await git.add(file);
    }
    await git.raw([...COMMITTER, "commit", "--no-edit"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const checkout = (branch: string) => git.raw(["checkout", branch]);
  await commit("shared", "base line\n");
  await git.raw(["checkout", "-b", "node"]);
  return { origin, git, commit, remove, merge, checkout };
}

async function roundEvaluation(
  t: test.TestContext,
  names: readonly string[],
  build: (
    origins: Record<string, Awaited<ReturnType<typeof roundOrigin>>>,
  ) => Promise<{
    snapshots: Record<string, string>;
    base: Record<string, string>;
  }>,
) {
  const state = temporary(t);
  const origins: Record<string, Awaited<ReturnType<typeof roundOrigin>>> = {};
  for (const name of names) origins[name] = await roundOrigin(state, name);
  const { snapshots, base } = await build(origins);
  for (const origin of Object.values(origins)) await origin.checkout("main");
  const repositories = names.map((name) => ({
    ...repositorySetup(),
    name,
    address: origins[name]!.origin,
  }));
  const setup = anthropicSetup({
    intent: ExecutionIntent.Implement,
    repositories,
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
  const address = (name: string, commit: string) => ({
    kind: "repository" as const,
    binding_id: repositories.find((entry) => entry.name === name)!.binding_id,
    commit,
  });
  const evidence = [
    {
      id: "evidence_1",
      assets: names.map((name) => ({
        id: createIdentity("evidence_asset"),
        kind: "repository",
        address: address(name, snapshots[name]!),
      })),
    },
  ] as Evidence[];
  const logs: { message: string; fields: unknown }[] = [];
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.mock.method(run, "log", (message: string, fields: unknown) => {
    logs.push({ message, fields });
  });
  stopAfter(t, () => run.dispose());
  const workspaces = WorkspaceRoot.open(join(state, "workspaces"));
  const reviewBase = Object.entries(base).map(([name, commit]) =>
    address(name, commit),
  );
  const round = {
    round: 2,
    final: false,
    review_base:
      reviewBase.length === SINGLE_BINDING ? reviewBase[0]! : reviewBase,
    findings: [],
  };
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
    round,
  );
  stopAfter(t, () => workspaces.release(prepared.key, prepared.kind));
  return { prepared, logs, round };
}

test("round 2 reviews only the fix commits and no base merge", async (t) => {
  const { prepared, round, logs } = await roundEvaluation(
    t,
    ["repo"],
    async ({ repo }) => {
      await repo!.commit("first.md");
      const judged = await repo!.commit("judged.md");
      await repo!.checkout("main");
      await repo!.commit("upstream.md");
      await repo!.checkout("node");
      await repo!.merge("main");
      await repo!.commit("fix.md");
      await repo!.commit("judged.md", "fixed\n");
      const head = await repo!.commit("gone.md");
      return { snapshots: { repo: head }, base: { repo: judged } };
    },
  );
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    "fix.md",
    "gone.md",
    "judged.md",
  ]);
  assert.deepEqual(prepared.reviewBundle.added_files, ["fix.md", "gone.md"]);
  assert.deepEqual(prepared.reviewBundle.round, {
    number: 2,
    review_base: round.review_base,
  });
  const path = join("..", "..", EVIDENCE_DIRECTORY, "round-2-repo.patch");
  assert.deepEqual(prepared.reviewBundle.patch_paths, [path]);
  assert.deepEqual(prepared.reviewBundle.empty_patches, []);
  const patch = readFileSync(join(prepared.directory, path), "utf8");
  assert.match(patch, /\+\+\+ b\/fix\.md/);
  assert.match(patch, /\+fixed/);
  assert.doesNotMatch(patch, /upstream\.md|first\.md/);
  assert.equal(prepared.patches.length, ONE_ENTRY);
  assert.equal(prepared.patches[0]!.text, patch);
  assert.equal(prepared.patches[0]!.path, path);
  assert.deepEqual(
    logs.filter((entry) => entry.message.startsWith("review base")),
    [],
  );
});

test("a conflict merge adds only its resolution to the round patch", async (t) => {
  const { prepared } = await roundEvaluation(t, ["repo"], async ({ repo }) => {
    const judged = await repo!.commit("shared", "node line\n");
    await repo!.checkout("main");
    await repo!.commit("shared", "main line\n");
    await repo!.commit("upstream.md");
    await repo!.checkout("node");
    const head = await repo!.merge("main", { shared: "resolved line\n" });
    return { snapshots: { repo: head }, base: { repo: judged } };
  });
  assert.deepEqual(prepared.reviewBundle.changed_files, ["shared"]);
  assert.deepEqual(prepared.reviewBundle.added_files, []);
  const patch = prepared.patches[0]!.text;
  assert.match(patch, /\+resolved line/);
  assert.doesNotMatch(patch, /b\/upstream\.md/);
});

test("a review base that is an ancestor only through a second parent gives the full change", async (t) => {
  const { prepared, logs } = await roundEvaluation(
    t,
    ["repo"],
    async ({ repo }) => {
      await repo!.commit("node.md");
      await repo!.checkout("main");
      const upstream = await repo!.commit("upstream.md");
      await repo!.checkout("node");
      await repo!.merge("main");
      const head = await repo!.commit("fix.md");
      return { snapshots: { repo: head }, base: { repo: upstream } };
    },
  );
  assert.deepEqual(prepared.reviewBundle.changed_files, ["fix.md", "node.md"]);
  assert.deepEqual(prepared.reviewBundle.added_files.toSorted(), [
    "fix.md",
    "node.md",
  ]);
  const path = join("..", "..", EVIDENCE_DIRECTORY, "round-2-repo.patch");
  assert.deepEqual(prepared.reviewBundle.patch_paths, [path]);
  assert.equal(prepared.patches.length, ONE_ENTRY);
  const patch = prepared.patches[0]!.text;
  assert.equal(readFileSync(join(prepared.directory, path), "utf8"), patch);
  assert.match(patch, /\+\+\+ b\/node\.md/);
  assert.match(patch, /\+\+\+ b\/fix\.md/);
  assert.doesNotMatch(patch, /upstream\.md/);
  assert.deepEqual(
    logs.filter((entry) => entry.message === OFF_HISTORY).length,
    ONE_ENTRY,
  );
});

test("a review base equal to the head gives an empty patch and an empty_patches entry", async (t) => {
  const { prepared } = await roundEvaluation(t, ["repo"], async ({ repo }) => {
    const head = await repo!.commit("node.md");
    return { snapshots: { repo: head }, base: { repo: head } };
  });
  assert.deepEqual(prepared.reviewBundle.changed_files, []);
  assert.deepEqual(prepared.reviewBundle.added_files, []);
  assert.deepEqual(prepared.reviewBundle.patch_paths, []);
  assert.deepEqual(prepared.reviewBundle.empty_patches, ["repo"]);
  assert.deepEqual(prepared.patches, []);
  assert.deepEqual(
    readdirSync(join(prepared.key, EVIDENCE_DIRECTORY)).filter((file) =>
      file.endsWith(".patch"),
    ),
    [],
  );
});

test("a binding with no review-base commit gives the full change", async (t) => {
  const { prepared, logs } = await roundEvaluation(
    t,
    ["api", "web"],
    async ({ api, web }) => {
      const judged = await api!.commit("api.md");
      const apiHead = await api!.commit("api-fix.md");
      const webHead = await web!.commit("web.md");
      return {
        snapshots: { api: apiHead, web: webHead },
        base: { api: judged },
      };
    },
  );
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    join("api", "api-fix.md"),
    join("web", "web.md"),
  ]);
  assert.deepEqual(prepared.reviewBundle.patch_paths, [
    join("..", EVIDENCE_DIRECTORY, "round-2-api.patch"),
    join("..", EVIDENCE_DIRECTORY, "round-2-web.patch"),
  ]);
  assert.deepEqual(
    prepared.patches.map((patch) => patch.name),
    ["api", "web"],
  );
  const [api, web] = prepared.patches;
  assert.match(api!.text, /\+\+\+ b\/api-fix\.md/);
  assert.doesNotMatch(api!.text, /b\/api\.md/);
  assert.match(web!.text, /\+\+\+ b\/web\.md/);
  assert.deepEqual(
    logs
      .filter((entry) => entry.message === OFF_HISTORY)
      .map((entry) => (entry.fields as { binding: string }).binding),
    ["web"],
  );
});

test("a file that the round adds and then deletes is not in added_files", async (t) => {
  const { prepared } = await roundEvaluation(t, ["repo"], async ({ repo }) => {
    const judged = await repo!.commit("node.md");
    await repo!.commit("temporary.md");
    await repo!.remove("temporary.md");
    const head = await repo!.commit("kept.md");
    return { snapshots: { repo: head }, base: { repo: judged } };
  });
  assert.deepEqual(prepared.reviewBundle.added_files, ["kept.md"]);
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    "kept.md",
    "temporary.md",
  ]);
});

test("a file that the round adds and then renames is in added_files under its new name", async (t) => {
  const { prepared } = await roundEvaluation(t, ["repo"], async ({ repo }) => {
    const judged = await repo!.commit("node.md");
    await repo!.commit("draft.md");
    await repo!.git.raw(["mv", "draft.md", "final.md"]);
    await repo!.git.raw([...COMMITTER, "commit", "-m", "rename draft.md"]);
    const head = (await repo!.git.revparse(["HEAD"])).trim();
    return { snapshots: { repo: head }, base: { repo: judged } };
  });
  assert.deepEqual(prepared.reviewBundle.added_files, ["final.md"]);
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    "draft.md",
    "final.md",
  ]);
});

test("a fallback binding with no change gives an empty_patches entry and no patch", async (t) => {
  const { prepared } = await roundEvaluation(
    t,
    ["api", "web"],
    async ({ api, web }) => {
      const judged = await api!.commit("api.md");
      const apiHead = await api!.commit("api-fix.md");
      const webHead = (await web!.git.revparse(["main"])).trim();
      return {
        snapshots: { api: apiHead, web: webHead },
        base: { api: judged },
      };
    },
  );
  assert.deepEqual(prepared.reviewBundle.empty_patches, ["web"]);
  assert.deepEqual(prepared.reviewBundle.patch_paths, [
    join("..", EVIDENCE_DIRECTORY, "round-2-api.patch"),
  ]);
  assert.deepEqual(
    prepared.patches.map((patch) => patch.name),
    ["api"],
  );
  assert.deepEqual(prepared.reviewBundle.changed_files, [
    join("api", "api-fix.md"),
  ]);
});
