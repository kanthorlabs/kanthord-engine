import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import type { Revision } from "../../mission/contract.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  conflictInstruction,
  RefreshResult,
  refreshAtClaim,
  refreshBeforeRelease,
} from "./base-refresh.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture,
} from "./test-support.ts";
import { sshAccessOf } from "./workspace.ts";
import type { SshAccess } from "../../repository/contract.ts";

const BINDINGS = ["api", "web"];
const DEADLINE_MS = 20000;
const BASE_CHANGE = "base change";
const RESOLVED = "resolved";
const ONE_VERIFICATION = 1;
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

test("one conflict before the release resets every checkout", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  const before = [api.head, web.head];
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "other");
  await advanceBase({ bare: webBare }, t, "main side");
  assert.equal(await refreshBeforeRelease(h, async () => true), false);
  assert.deepEqual([api.head, web.head], before);
  for (const checkout of h.checkouts) {
    assert.equal(await headOf(checkout.directory), checkout.head);
    assert.equal(
      (await simpleGit(checkout.directory).status()).isClean(),
      true,
    );
  }
});

test("a failed verification on the merged heads resets every checkout", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  const before = [api.head, web.head];
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "other");
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "other");
  const verified: string[][] = [];
  assert.equal(
    await refreshBeforeRelease(h, async () => {
      verified.push(h.checkouts.map((checkout) => checkout.head));
      return false;
    }),
    false,
  );
  assert.equal(verified.length, ONE_VERIFICATION);
  assert.notDeepEqual(verified[0], before);
  assert.deepEqual([api.head, web.head], before);
  for (const checkout of h.checkouts)
    assert.equal(await headOf(checkout.directory), checkout.head);
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
  assert.equal(await refreshBeforeRelease(h, async () => true), true);
  assert.deepEqual(
    fetched,
    h.checkouts.map((checkout) => ({
      directory: checkout.directory,
      ssh: h.input.sshAccess.get(checkout.binding_id),
    })),
  );
});
