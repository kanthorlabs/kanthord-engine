import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { CleanupRefusal } from "../kernel/cleanup.ts";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  CleanupRule,
  FootprintKind,
  RUNTIME_STORE_DEVICE,
} from "../footprint/contract.ts";
import {
  ContainerRuntime,
  type RuntimeImageUsage,
} from "../worker/contract.ts";
import {
  ENVIRONMENT_IMAGE_PREFIX,
  type EnvironmentCacheVolume,
  environmentPath,
  ProofFiles,
  PROVED_SUFFIX,
} from "./environment-state.ts";
import { type BoundRepository, ProjectFootprint } from "./footprint.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOUND = "repository:github:acme/app";
const UNBOUND = "repository:github:acme/old";
const CURRENT = "c".repeat(64);
const OLD = "d".repeat(64);
const GONE = "e".repeat(64);
const DANGLING = `sha256:${"f".repeat(64)}`;
const BOUND_PATH = environmentPath(BOUND);
const UNBOUND_PATH = environmentPath(UNBOUND);
const DAY = 86400000;
const NOW = Date.parse("2026-11-05T00:00:00Z");
const ENVIRONMENT_COUNT = 4;
const ENVIRONMENT_BYTES = 1002;
const NO_ITEMS = 0;
const OLD_BYTES = 200;
const UNBOUND_VOLUME_BYTES = 20;
const REQUESTER = { kind: "human", account: "ulrich", name: "Ulrich" } as const;

function imageOf(
  id: string,
  references: string[],
  bytes: number,
  containers = 0,
): RuntimeImageUsage {
  return {
    id,
    references,
    created_at: NOW - 40 * DAY,
    unique_bytes: bytes,
    containers,
  };
}

function tagOf(path: string, digest: string, suffix = ""): string {
  return `${ENVIRONMENT_IMAGE_PREFIX}/${path}:${digest}${suffix}`;
}

function harness(
  t: TestContext,
  options: {
    images?: RuntimeImageUsage[];
    volumes?: Array<{ name: string; bytes: number; links: number }>;
    caches?: EnvironmentCacheVolume[];
    bound?: BoundRepository[];
    fail?: boolean;
  } = {},
) {
  const root = join(temporary(t), "environments");
  const proofs = new ProofFiles(root);
  const removedTags: string[][] = [];
  const removedImages: string[] = [];
  const removedVolumes: string[] = [];
  const images = options.images ?? [];
  const footprint = new ProjectFootprint({
    runtime: {
      footprintUsage: async () => {
        if (options.fail) throw new Error("No container runtime is available.");
        return {
          usage: {
            runtime: ContainerRuntime.Podman,
            images,
            volumes: options.volumes ?? [],
          },
          owned_image_ids: images.map((image) => image.id),
          cache_volumes: options.caches ?? [],
        };
      },
      removeImage: async (reference) => {
        removedImages.push(reference);
        return true;
      },
      removeTags: async (tags) => {
        removedTags.push([...tags]);
      },
      removeCacheVolume: async (projectId, resourceIdentity) => {
        removedVolumes.push(`${projectId} ${resourceIdentity}`);
      },
    },
    proofs,
    proofRoot: root,
    bound: () =>
      options.bound ?? [
        { project_id: PROJECT_ID, resource_identity: BOUND, digest: CURRENT },
      ],
    logger: pino({ level: "silent" }),
    now: () => NOW,
  });
  const writeProof = (path: string, digest: string) => {
    mkdirSync(join(root, path), { recursive: true });
    const file = join(root, path, `${digest}.json`);
    writeFileSync(file, "{}");
    const time = new Date(NOW - 50 * DAY);
    utimesSync(file, time, time);
    return file;
  };
  return {
    footprint,
    proofs,
    root,
    writeProof,
    removedTags,
    removedImages,
    removedVolumes,
  };
}

function query(
  kind: typeof FootprintKind.Environment | typeof FootprintKind.CacheVolume,
  rule: { name: CleanupRule } | null,
) {
  return {
    kind,
    instance_name: null,
    rule: rule as never,
    offset: 0,
    limit: 100,
    now: NOW,
    signal: background.signal,
  };
}

const ENVIRONMENT_IMAGES = [
  imageOf(
    `sha256:${"1".repeat(64)}`,
    [tagOf(BOUND_PATH, CURRENT), tagOf(BOUND_PATH, CURRENT, PROVED_SUFFIX)],
    100,
  ),
  imageOf(`sha256:${"2".repeat(64)}`, [tagOf(BOUND_PATH, OLD)], OLD_BYTES),
  imageOf(`sha256:${"3".repeat(64)}`, [tagOf(UNBOUND_PATH, GONE)], 300),
  imageOf(DANGLING, [], 400),
];

test("the environment measure sums the unique size of the owned images and the proof files on the runtime store", async (t) => {
  const h = harness(t, { images: ENVIRONMENT_IMAGES });
  h.writeProof(BOUND_PATH, CURRENT);
  const [environment, cache] = await h.footprint.measure(background.signal);
  assert.equal(environment?.kind, FootprintKind.Environment);
  assert.equal(environment?.count, ENVIRONMENT_COUNT);
  assert.equal(environment?.bytes, ENVIRONMENT_BYTES);
  assert.equal(environment?.device, RUNTIME_STORE_DEVICE);
  assert.equal(environment?.recent_count, NO_ITEMS);
  assert.equal(cache?.kind, FootprintKind.CacheVolume);
  assert.equal(cache?.count, NO_ITEMS);
});

test("a runtime failure answers a measure error for both kinds and throws nothing", async (t) => {
  const h = harness(t, { fail: true });
  const measures = await h.footprint.measure(background.signal);
  assert.deepEqual(
    measures.map((measure) => [measure.kind, measure.measure_error?.code]),
    [
      [FootprintKind.Environment, "project.footprint.runtime_unmeasured"],
      [FootprintKind.CacheVolume, "project.footprint.runtime_unmeasured"],
    ],
  );
});

test("unbound selects the keys of an unbound path, superseded selects the other digests of a bound path with a proved current digest", async (t) => {
  const h = harness(t, { images: ENVIRONMENT_IMAGES });
  h.writeProof(BOUND_PATH, CURRENT);
  const unbound = await h.footprint.candidates(
    query(FootprintKind.Environment, { name: CleanupRule.Unbound }),
  );
  assert.deepEqual(
    unbound.items.map((item) => item.key),
    [`${UNBOUND_PATH}@${GONE}`],
  );
  const superseded = await h.footprint.candidates(
    query(FootprintKind.Environment, { name: CleanupRule.Superseded }),
  );
  assert.deepEqual(
    superseded.items.map((item) => item.key),
    [`${BOUND_PATH}@${OLD}`],
  );
  assert.equal(superseded.total_bytes, OLD_BYTES);
  const all = await h.footprint.candidates(
    query(FootprintKind.Environment, null),
  );
  const current = all.items.find(
    (item) => item.key === `${BOUND_PATH}@${CURRENT}`,
  );
  assert.equal(current?.refusal, CleanupRefusal.Live);
  assert.ok(all.items.some((item) => item.key === DANGLING));
});

test("environment delete removes the tags and the proof of a key together and refuses the bound current digest", async (t) => {
  const h = harness(t, { images: ENVIRONMENT_IMAGES });
  const proof = h.writeProof(BOUND_PATH, OLD);
  h.writeProof(BOUND_PATH, CURRENT);
  const answer = await h.footprint.deleteEnvironments(
    [
      `${BOUND_PATH}@${OLD}`,
      `${BOUND_PATH}@${CURRENT}`,
      `${BOUND_PATH}@${GONE}`,
    ],
    REQUESTER,
    background.signal,
  );
  assert.deepEqual(answer, {
    removed: 1,
    absent: 1,
    refused: [{ key: `${BOUND_PATH}@${CURRENT}`, reason: "live" }],
  });
  assert.deepEqual(h.removedTags, [
    [
      tagOf(BOUND_PATH, OLD),
      tagOf(BOUND_PATH, OLD, "-base"),
      tagOf(BOUND_PATH, OLD, "-proved"),
      tagOf(BOUND_PATH, OLD, "-unchecked"),
    ],
  ]);
  assert.equal(existsSync(proof), false);
});

test("environment delete removes the image of an untagged key and refuses an image that a container uses", async (t) => {
  const used = `sha256:${"9".repeat(64)}`;
  const h = harness(t, {
    images: [imageOf(DANGLING, [], 1), imageOf(used, [], 1, 1)],
  });
  const answer = await h.footprint.deleteEnvironments(
    [DANGLING, used],
    REQUESTER,
    background.signal,
  );
  assert.deepEqual(answer, {
    removed: 1,
    absent: 0,
    refused: [{ key: used, reason: "live" }],
  });
  assert.deepEqual(h.removedImages, [DANGLING]);
});

test("cache volume delete refuses a bound pair and a volume in use, and removes an unbound volume", async (t) => {
  const caches: EnvironmentCacheVolume[] = [
    {
      name: "kanthord_cache_aaaaaaaaaaaaaaaaaaaaaaaa",
      project_id: PROJECT_ID,
      resource_identity: BOUND,
      created_at: NOW - 40 * DAY,
    },
    {
      name: "kanthord_cache_bbbbbbbbbbbbbbbbbbbbbbbb",
      project_id: PROJECT_ID,
      resource_identity: UNBOUND,
      created_at: NOW - 40 * DAY,
    },
    {
      name: "kanthord_cache_cccccccccccccccccccccccc",
      project_id: PROJECT_ID,
      resource_identity: "repository:github:acme/used",
      created_at: NOW,
    },
  ];
  const h = harness(t, {
    caches,
    volumes: [
      { name: caches[0]!.name, bytes: 10, links: 0 },
      { name: caches[1]!.name, bytes: UNBOUND_VOLUME_BYTES, links: 0 },
      { name: caches[2]!.name, bytes: 30, links: 1 },
    ],
  });
  const unbound = await h.footprint.candidates(
    query(FootprintKind.CacheVolume, { name: CleanupRule.Unbound }),
  );
  assert.deepEqual(
    unbound.items.map((item) => item.key),
    [caches[1]!.name],
  );
  assert.equal(unbound.total_bytes, UNBOUND_VOLUME_BYTES);
  const answer = await h.footprint.deleteCacheVolumes(
    [
      ...caches.map((cache) => cache.name),
      "kanthord_cache_dddddddddddddddddddddddd",
    ],
    REQUESTER,
    background.signal,
  );
  assert.deepEqual(answer, {
    removed: 1,
    absent: 1,
    refused: [
      { key: caches[0]!.name, reason: "live" },
      { key: caches[2]!.name, reason: "live" },
    ],
  });
  assert.deepEqual(h.removedVolumes, [`${PROJECT_ID} ${UNBOUND}`]);
});
