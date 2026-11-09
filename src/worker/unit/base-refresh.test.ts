import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import type { Revision } from "../../mission/contract.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  conflictInstruction,
  refreshAtClaim,
  refreshAtRelease,
  RefreshResult,
} from "./base-refresh.ts";
import { releaseGate, ReleaseGateKind } from "./release-gate.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture,
} from "./test-support.ts";
import { RELEASE_DIRECTORY, sshAccessOf } from "./workspace.ts";
import { PoolClass, repoKeyOf } from "./tree-pool.ts";
import type { SshAccess } from "../../repository/contract.ts";

const BINDINGS = ["api", "web"];
const DEADLINE_MS = 20000;
const BASE_CHANGE = "base change";
const RESOLVED = "resolved";
const UPSTREAM = "up";
const BASE_BRANCH = "main";
const UPSTREAM_CHANGE = "upstream change";
const TWO_MERGES = "2";
const TWO_PARENTS = 2;
const NO_OUTPUT = "";
const ONE_TREE = 1;
const TEST_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const NODE_CONTENT = {
  name: "node",
  requirement: "node",
  criterion: "node",
  verifications: ["true"],
  bindings: [],
};

async function fixture(
  t: TestContext,
  script: Parameters<typeof implementFixture>[2] = [],
) {
  const h = await implementFixture(t, [], script, undefined, BINDINGS);
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  const [api, web] = h.checkouts;
  assert.ok(api && web);
  const [apiBare, webBare] = h.bares;
  assert.ok(apiBare && webBare);
  return { h, api, web, apiBare, webBare };
}

const headOf = async (directory: string) =>
  (await simpleGit(directory).revparse(["HEAD"])).trim();

test("a claim merges the base branch of each binding", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "api-base");
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  for (const checkout of h.checkouts)
    await h.input.transport.fetchBase(
      checkout.directory,
      "main",
      background,
      DEADLINE_MS,
      sshAccessOf(h.input.sshAccess, checkout.binding_id),
    );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(api.directory, "api-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(
    readFileSync(join(web.directory, "web-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(api.head, await headOf(api.directory));
  assert.equal(web.head, await headOf(web.directory));
});

test("the conflict instruction names the binding and the directory", async (t) => {
  assert.ok(
    conflictInstruction(
      SHIPPED_TEMPLATES,
      { binding: "web", directory: "web", base_branch: "main" },
      ["file"],
    ).startsWith(
      "The merge of origin/main into the node branch of repository web in directory `web` conflicts.",
    ),
  );
  const { h, web, webBare } = await fixture(t, [
    fauxAssistantMessage(
      fauxToolCall("write", { path: "web/file", content: RESOLVED }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resolved"),
  ]);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  await advanceBase({ bare: webBare }, t, "main side");
  await h.input.transport.fetchBase(
    web.directory,
    "main",
    background,
    DEADLINE_MS,
    sshAccessOf(h.input.sshAccess, web.binding_id),
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.ok(
    JSON.stringify(h.provider.calls[0]).includes(
      "node branch of repository web in directory `web` conflicts",
    ),
  );
  assert.equal(readFileSync(join(web.directory, "file"), "utf8"), RESOLVED);
});

test("a conflict at the release goes through the conflict turn and concludes the merge", async (t) => {
  const { h, web, webBare } = await fixture(t, [
    fauxAssistantMessage(
      fauxToolCall("write", { path: "web/file", content: RESOLVED }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resolved"),
  ]);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  const before = web.head;
  await advanceBase({ bare: webBare }, t, "main side");
  assert.equal(await refreshAtRelease(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(web.directory, "file"), "utf8"), RESOLVED);
  assert.equal(web.head, await headOf(web.directory));
  assert.equal(
    (await simpleGit(web.directory).raw(["rev-parse", `${web.head}^1`])).trim(),
    before,
  );
  assert.equal((await simpleGit(web.directory).status()).isClean(), true);
});

test("a failed release verification keeps the merged heads and routes a revision", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  h.revision = {
    content: { ...NODE_CONTENT, verifications: ["false"] },
    tasks: [],
  } as unknown as Revision;
  const before = [api.head, web.head];
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "other");
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "other");
  const gate = await releaseGate(h);
  assert.equal(gate.kind, ReleaseGateKind.Routed);
  assert.notDeepEqual([api.head, web.head], before);
  for (const checkout of h.checkouts) {
    assert.equal(await headOf(checkout.directory), checkout.head);
    assert.equal(
      readFileSync(join(checkout.directory, "other"), "utf8"),
      BASE_CHANGE,
    );
  }
  assert.equal(
    existsSync(
      join(
        h.input.workspaces.nodeKey(h.input.claim.node_id),
        RELEASE_DIRECTORY,
      ),
    ),
    false,
  );
  const pool = h.input.workspaces.pool;
  for (const repository of h.input.setup.repositories)
    assert.equal(
      pool
        .trees()
        .filter(
          (tree) =>
            dirname(tree.path) ===
            join(pool.root, repoKeyOf(repository.address), PoolClass.Command),
        ).length,
      ONE_TREE,
    );
});

test("the refresh fetches the base of each checkout with the SSH identity of its binding", async (t) => {
  const { h } = await fixture(t);
  const fetched: { directory: string; ssh: SshAccess }[] = [];
  const fetchBase = h.input.transport.fetchBase;
  h.input.transport = {
    ...h.input.transport,
    fetchBase: (directory, base, context, deadlineMs, ssh) => {
      fetched.push({ directory, ssh });
      return fetchBase(directory, base, context, deadlineMs, ssh);
    },
  };
  assert.equal(await refreshAtRelease(h), RefreshResult.Current);
  assert.deepEqual(
    fetched,
    h.checkouts.map((checkout) => ({
      directory: checkout.directory,
      ssh: h.input.sshAccess.get(checkout.binding_id),
    })),
  );
});

async function advanceUpstream(
  bare: string,
  t: TestContext,
  content: string,
  path = "file",
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(bare, clone, ["--branch", "main"]);
  const published = (
    await git.raw(["ls-remote", "--heads", "origin", UPSTREAM])
  ).trim();
  await git.raw([
    "checkout",
    "-B",
    UPSTREAM,
    published === NO_OUTPUT ? BASE_BRANCH : `origin/${UPSTREAM}`,
  ]);
  writeFileSync(join(clone, path), content);
  await git.add(path);
  await git.raw([
    ...TEST_IDENTITY,
    "commit",
    "-m",
    `upstream change of ${path}`,
  ]);
  await git.push("origin", UPSTREAM);
}

function followUpstream(h: Awaited<ReturnType<typeof fixture>>["h"]) {
  h.input.setup.repositories[1]!.strategy.upstream_branch = UPSTREAM;
}

const parentsOf = async (directory: string, commit: string) =>
  (await simpleGit(directory).raw(["rev-list", "--parents", "-n", "1", commit]))
    .trim()
    .split(" ")
    .slice(1);

test("a claim refresh keeps the merge commit of the base", async (t) => {
  const { h, web, webBare } = await fixture(t);
  const before = web.head;
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  await h.input.transport.fetchBase(
    web.directory,
    "main",
    background,
    DEADLINE_MS,
    sshAccessOf(h.input.sshAccess, web.binding_id),
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  const parents = await parentsOf(web.directory, web.head);
  assert.equal(parents.length, TWO_PARENTS);
  assert.equal(parents[0], before);
  assert.equal(web.head, await headOf(web.directory));
});

test("a claim with upstream_branch merges the base, then the upstream, and the head has two merge commits", async (t) => {
  const { h, web, webBare } = await fixture(t);
  followUpstream(h);
  const before = web.head;
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  await advanceUpstream(webBare, t, UPSTREAM_CHANGE, "web-upstream");
  for (const branch of ["main", UPSTREAM])
    await h.input.transport.fetchBase(
      web.directory,
      branch,
      background,
      DEADLINE_MS,
      sshAccessOf(h.input.sshAccess, web.binding_id),
    );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(web.directory, "web-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(
    readFileSync(join(web.directory, "web-upstream"), "utf8"),
    UPSTREAM_CHANGE,
  );
  const git = simpleGit(web.directory);
  assert.equal(
    (
      await git.raw(["rev-list", "--merges", "--count", `${before}..HEAD`])
    ).trim(),
    TWO_MERGES,
  );
  const subjects = (
    await git.raw(["log", "--merges", "--format=%s", `${before}..HEAD`])
  )
    .trim()
    .split("\n");
  assert.ok(subjects[0]?.endsWith(UPSTREAM));
  assert.ok(subjects[1]?.endsWith("main"));
  assert.equal(web.head, await headOf(web.directory));
});

test("an upstream conflict runs the conflict turn and the result keeps two parents", async (t) => {
  const { h, web, webBare } = await fixture(t, [
    fauxAssistantMessage(
      fauxToolCall("write", { path: "web/file", content: RESOLVED }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resolved"),
  ]);
  followUpstream(h);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  const before = web.head;
  await advanceUpstream(webBare, t, "upstream side");
  assert.equal(await refreshAtRelease(h), RefreshResult.Merged);
  assert.ok(
    JSON.stringify(h.provider.calls[0]).includes(
      `The merge of origin/${UPSTREAM} into the node branch of repository web`,
    ),
  );
  assert.equal(readFileSync(join(web.directory, "file"), "utf8"), RESOLVED);
  assert.equal(web.head, await headOf(web.directory));
  assert.equal((await parentsOf(web.directory, web.head)).length, TWO_PARENTS);
  assert.equal((await parentsOf(web.directory, web.head))[0], before);
  assert.equal((await simpleGit(web.directory).status()).isClean(), true);
});

test("a release fetches the base and the upstream branch before the merge", async (t) => {
  const { h, api, web, webBare } = await fixture(t);
  followUpstream(h);
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  await advanceUpstream(webBare, t, UPSTREAM_CHANGE, "web-upstream");
  const fetched: string[] = [];
  const fetchBase = h.input.transport.fetchBase;
  h.input.transport = {
    ...h.input.transport,
    fetchBase: (directory, branch, context, deadlineMs, ssh) => {
      fetched.push(`${directory}:${branch}`);
      return fetchBase(directory, branch, context, deadlineMs, ssh);
    },
  };
  assert.equal(await refreshAtRelease(h), RefreshResult.Merged);
  assert.deepEqual(fetched, [
    `${api.directory}:main`,
    `${web.directory}:main`,
    `${web.directory}:${UPSTREAM}`,
  ]);
  assert.equal(
    readFileSync(join(web.directory, "web-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(
    readFileSync(join(web.directory, "web-upstream"), "utf8"),
    UPSTREAM_CHANGE,
  );
});

test("with no upstream_branch the refresh runs the same git calls as before", async (t) => {
  const { h, api, web } = await fixture(t);
  const log = join(temporary(t), "git-calls");
  const shims = temporary(t);
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(shims, "git");
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> '${log}'\nexec '${real}' "$@"\n`,
  );
  chmodSync(shim, 0o755);
  h.input.env = {
    ...h.input.env,
    PATH: `${shims}:${h.input.env.PATH ?? ""}`,
  };
  assert.equal(await refreshAtClaim(h), RefreshResult.Current);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  const directories = [api.directory, web.directory].map((directory) =>
    realpathSync(directory),
  );
  assert.deepEqual(
    calls.map((call) => call.replace(/^\S+ /, "")),
    directories.flatMap(() => [
      "rev-parse origin/main",
      "merge-base HEAD origin/main",
    ]),
  );
});
