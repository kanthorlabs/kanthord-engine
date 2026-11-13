import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HttpStatus } from "../../kernel/http.ts";
import {
  AssetKind,
  type Evidence,
  Intent,
  type Mission,
  MissionErrorCode,
  type NodeChange,
} from "../../mission/contract.ts";
import { gatewayFixture } from "./test-support.ts";
import {
  cliMachine,
  cliSession,
  createCredentials,
  passingEvaluation,
} from "./cli-test-support.ts";

const REPOSITORY_KEY = "download-test-repository-key";
const REPOSITORY = "repo";
const HARNESS = "harness";
const COMMIT = "a".repeat(40);
const FIRST_VERSION = 1;
const FIRST_INDEX = 0;
const PRODUCED_TEXT = "ok";
const PRODUCED_SIZE = PRODUCED_TEXT.length;
const TIMEOUT = 300000;
const OCTET_STREAM = "application/octet-stream";
const NOSNIFF = "nosniff";
const TEXT_MEDIA_TYPE = "text/plain";
const RANGE_QUERY = "?offset=1&length=1";
const RANGE_TEXT = "k";
type Page<T> = { items: T[]; next_cursor: string | null };
type Binding = { id: string; name: string; resource_identity: string };

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const session = cliSession(
    t,
    fixture.endpoint,
    fixture.token,
    REPOSITORY_KEY,
  );
  const { read, write } = session;
  await createCredentials(session, REPOSITORY_KEY);
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "evidence-download",
  ]);
  const mission = await read<Mission>(["mission", "get", project.id]);
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_VERSION,
    bindings: {
      [REPOSITORY]: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          strategy: { base_branch: "main" },
          ssh_credential: "github-ssh",
          credential: "github",
        },
      },
      [HARNESS]: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: 1 },
      },
    },
  });
  const bindings = await read<Page<Binding>>([
    "project",
    "binding",
    "list",
    project.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((item) => item.name === name)!;
  const change = await write<NodeChange>(
    ["mission", "node", "create", mission.id],
    {
      filename: "implement.md",
      content: {
        name: "Recover accounts",
        requirement: "Recover accounts",
        criterion: "Accounts recover",
        verifications: ["true"],
        intent: Intent.Implement,
        bindings: [binding(REPOSITORY).id],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  const nodeId = change.revisions[FIRST_INDEX]!.node_id;
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding(HARNESS).resource_identity,
  });
  await passingEvaluation(session, machine, {
    nodeId,
    bindingId: binding(REPOSITORY).id,
    commit: COMMIT,
  });
  const evidence = await read<Page<Evidence>>([
    "mission",
    "evidence",
    "list",
    nodeId,
  ]);
  const assetOf = (kind: string) => {
    const asset = evidence.items
      .flatMap((item) => item.assets)
      .find((item) => item.address.kind === kind);
    assert.ok(asset);
    return asset.id;
  };
  const download = (assetId: string, query = "") =>
    fetch(
      `${fixture.endpoint}/api/mission/evidence/asset/${assetId}/content/download${query}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    );
  return {
    producedId: assetOf(AssetKind.Produced),
    repositoryId: assetOf(AssetKind.Repository),
    download,
  };
}

test(
  "the evidence download answers produced bytes as an attachment and refuses a bad range or a repository asset",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await t.test("happy path: whole content and a range", async () => {
      const whole = await h.download(h.producedId);
      assert.equal(whole.status, HttpStatus.OK);
      assert.equal(await whole.text(), PRODUCED_TEXT);
      assert.equal(whole.headers.get("content-type"), OCTET_STREAM);
      assert.equal(whole.headers.get("x-content-type-options"), NOSNIFF);
      assert.equal(
        whole.headers.get("content-disposition"),
        `attachment; filename="${h.producedId}.txt"`,
      );
      assert.equal(whole.headers.get("x-evidence-media-type"), TEXT_MEDIA_TYPE);
      assert.equal(whole.headers.get("x-evidence-size"), String(PRODUCED_SIZE));
      const ranged = await h.download(h.producedId, RANGE_QUERY);
      assert.equal(ranged.status, HttpStatus.OK);
      assert.equal(await ranged.text(), RANGE_TEXT);
    });
    await t.test(
      "security, argument guard: an offset at the size answers 400",
      async () => {
        const response = await h.download(
          h.producedId,
          `?offset=${PRODUCED_SIZE}`,
        );
        assert.equal(response.status, HttpStatus.BadRequest);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(
          body.error.code,
          MissionErrorCode.EvidenceContentRangeInvalid,
        );
      },
    );
    await t.test(
      "security, refused path: a repository asset answers 409",
      async () => {
        const response = await h.download(h.repositoryId);
        assert.equal(response.status, HttpStatus.Conflict);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(
          body.error.code,
          MissionErrorCode.EvidenceContentRepository,
        );
      },
    );
  },
);
