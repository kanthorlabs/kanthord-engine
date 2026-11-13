import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { httpClient } from "../../gateway/client.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  AssetKind,
  type Evidence,
  Intent,
  type Mission,
  missionOperations,
  type NodeChange,
} from "../../mission/contract.ts";
import {
  cliMachine,
  cliSession,
  createCredentials,
  executionContext,
  passingEvaluation,
} from "./cli-test-support.ts";
import type { fakeS3 } from "./test-support.ts";

const REPOSITORY_KEY = "evidence-seed-repository-key";
const STORAGE_SECRET_KEY = "evidence-seed-storage-key";
const REPOSITORY = "repo";
const STORE = "store";
const HARNESS = "harness";
const REGION = "eu-central-1";
const STORAGE_PREFIX = "kanthord";
const COMMIT = "a".repeat(40);
const FIRST_VERSION = 1;
const FIRST_INDEX = 0;
const TEXT_MEDIA_TYPE = "text/plain";

export interface SeedFixture {
  endpoint: string;
  token: string;
  config: { master_key: string };
}

export interface SeedNode {
  produced: readonly string[];
  object?: string;
}

export interface SeedAsset {
  evidenceId: string;
  assetId: string;
}

export interface SeededNode {
  nodeId: string;
  produced: SeedAsset[];
  object: SeedAsset | null;
}

export interface SeedOptions {
  s3?: Awaited<ReturnType<typeof fakeS3>>;
}

type Page<T> = { items: T[]; next_cursor: string | null };
type Binding = { id: string; name: string; resource_identity: string };
type Upload = { asset_id: string; put_url: string };

function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  return result.data;
}

function bindingsOf(options: SeedOptions) {
  const { s3 } = options;
  return {
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
    ...(s3
      ? {
          [STORE]: {
            kind: "storage",
            config: {
              available: true,
              endpoint: s3.endpoint,
              bucket: s3.bucket,
              region: REGION,
              prefix: STORAGE_PREFIX,
              credential: STORE,
            },
          },
        }
      : {}),
    [HARNESS]: {
      kind: "worker",
      config: { worker: "claude-code@1", instance_count: 1 },
    },
  };
}

export async function seedEvidence(
  t: TestContext,
  fixture: SeedFixture,
  nodes: readonly SeedNode[],
  options: SeedOptions = {},
): Promise<SeededNode[]> {
  const { s3 } = options;
  const session = cliSession(
    t,
    fixture.endpoint,
    fixture.token,
    REPOSITORY_KEY,
  );
  const { read, write } = session;
  await createCredentials(session, REPOSITORY_KEY);
  if (s3)
    await write(["storage", "credential", "create"], {
      name: STORE,
      platform: "s3",
      metadata: { endpoint: s3.endpoint, bucket: s3.bucket, region: REGION },
      secret: {
        access_key_id: "AKIAEXAMPLE",
        secret_access_key: STORAGE_SECRET_KEY,
      },
    });
  const project = await read<{ id: string }>([
    "project",
    "create",
    "--name",
    "evidence-seed",
  ]);
  const mission = await read<Mission>(["mission", "get", project.id]);
  await write(["project", "binding", "apply", project.id], {
    version: FIRST_VERSION,
    bindings: bindingsOf(options),
  });
  const bindings = await read<Page<Binding>>([
    "project",
    "binding",
    "list",
    project.id,
  ]);
  const binding = (name: string) =>
    bindings.items.find((item) => item.name === name)!;
  const machine = await cliMachine(session, {
    masterKey: fixture.config.master_key,
    projectId: project.id,
    resourceIdentity: binding(HARNESS).resource_identity,
  });
  const api = httpClient(missionOperations, fixture.endpoint, machine.token);
  const seeded: SeededNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const missionVersion = (await read<Mission>(["mission", "get", project.id]))
      .version;
    const change = await write<NodeChange>(
      ["mission", "node", "create", mission.id],
      {
        filename: `implement-${index}.md`,
        content: {
          name: `Recover accounts ${index}`,
          requirement: "Recover accounts",
          criterion: "Accounts recover",
          verifications: ["true"],
          intent: Intent.Implement,
          bindings: [
            binding(REPOSITORY).id,
            ...(s3 && node.object !== undefined ? [binding(STORE).id] : []),
          ],
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: missionVersion,
      },
    );
    const nodeId = change.revisions[FIRST_INDEX]!.node_id;
    const submitted: string[] = [];
    let objectEvidenceId = "";
    let objectAssetId = "";
    await passingEvaluation(session, machine, {
      nodeId,
      bindingId: binding(REPOSITORY).id,
      commit: COMMIT,
      executing: async (execution) => {
        const context = executionContext(execution);
        for (const text of node.produced) {
          const answer = completed(
            await api["evidence.submit"](
              {
                params: { node_id: nodeId },
                query: {},
                body: {
                  ...context,
                  subject: "notes",
                  assets: [
                    {
                      kind: AssetKind.Produced,
                      content: {
                        media_type: TEXT_MEDIA_TYPE,
                        encoding: "base64",
                        data: Buffer.from(text).toString("base64"),
                      },
                    },
                  ],
                },
              },
              { idempotencyKey: createIdempotencyKey() },
            ),
          );
          submitted.push(answer.evidence.id);
        }
        if (node.object === undefined) return;
        const answer = completed(
          await api["evidence.submit"](
            {
              params: { node_id: nodeId },
              query: {},
              body: {
                ...context,
                subject: "recording",
                assets: [
                  {
                    kind: AssetKind.Object,
                    media_type: TEXT_MEDIA_TYPE,
                    size: Buffer.byteLength(node.object),
                  },
                ],
              },
            },
            { idempotencyKey: createIdempotencyKey() },
          ),
        );
        const upload = answer.uploads[FIRST_INDEX] as Upload;
        const put = await fetch(upload.put_url, {
          method: HttpMethod.Put,
          body: node.object,
        });
        assert.equal(put.status, HttpStatus.OK);
        await put.arrayBuffer();
        completed(
          await api["evidence.asset.complete"](
            { params: { asset_id: upload.asset_id }, query: {}, body: context },
            { idempotencyKey: createIdempotencyKey() },
          ),
        );
        objectAssetId = upload.asset_id;
        objectEvidenceId = answer.evidence.id;
      },
    });
    const listed = await read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      nodeId,
    ]);
    const assetOf = (evidenceId: string, kind: string): SeedAsset => {
      const evidence = listed.items.find((item) => item.id === evidenceId);
      const asset = evidence?.assets.find((item) => item.address.kind === kind);
      assert.ok(asset);
      return { evidenceId, assetId: asset.id };
    };
    const produced = submitted.map((id) => assetOf(id, AssetKind.Produced));
    const object =
      node.object === undefined
        ? null
        : assetOf(objectEvidenceId, AssetKind.Object);
    assert.equal(object?.assetId ?? objectAssetId, objectAssetId);
    seeded.push({ nodeId, produced, object });
  }
  return seeded;
}
