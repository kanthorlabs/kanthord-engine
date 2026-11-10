import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  CleanupRefusal,
  InstanceCleanableKind,
  InstanceFootprintKind,
} from "../../kernel/cleanup.ts";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import type { FootprintMeasurement } from "../contract.ts";
import { UnitFootprint } from "./footprint.ts";
import { executionSessionRoot } from "./session-store.ts";
import { WorkspaceRoot } from "./workspace.ts";

const NOW = Date.UTC(2026, 10, 5, 9);
const DAY_MS = 86400000;
const CLEANUP_ID = "cleanup_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NODE_OLD = "node_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NODE_NEW = "node_01JABCDEFGHJKMNPQRSTVWXYZ1";
const EXECUTION_ENDED = "execution_01JABCDEFGHJKMNPQRSTVWXYZ0";
const EXECUTION_LIVE = "execution_01JABCDEFGHJKMNPQRSTVWXYZ1";
const OUTPUT_OLD = "pi-bash-0123456789abcdef.log";
const OUTPUT_NEW = "pi-bash-fedcba9876543210.log";
const OTHER_FILE = "notes.txt";
const UNIT_LOG = "kanthord.log";
const DEVICE = 77;
const OLD_WORKSPACE_BYTES = 10;
const NEW_WORKSPACE_BYTES = 20;
const OTHER_BYTES = 5;
const ONE_RECENT = 1;
const POOL_TREE_BYTES = 6;
const POOL_KEY = "pool";
const TWO_ITEMS = 2;

interface Layout {
  slot: string;
  data: string;
  temporaryDirectory: string;
  workspaces: WorkspaceRoot;
}

function file(path: string, bytes: number, at: number): void {
  writeFileSync(path, "x".repeat(bytes));
  utimesSync(path, at / 1000, at / 1000);
}

function layout(t: TestContext, container = false): Layout {
  const slot = temporary(t);
  const data = join(slot, "state", "kanthord");
  const temporaryDirectory = join(slot, "tmp");
  mkdirSync(data, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  if (container) {
    mkdirSync(join(slot, ".cache"));
    file(join(slot, ".cache", "blob"), 1000, NOW);
  }
  return {
    slot,
    data,
    temporaryDirectory,
    workspaces: WorkspaceRoot.open(data),
  };
}

function footprintOf(
  at: Layout,
  options: {
    worker?: boolean;
    runningSince?: number | null;
    live?: string[];
    residueRoot?: string;
  } = {},
): UnitFootprint {
  return new UnitFootprint({
    data: at.data,
    logDirectory: at.data,
    temporary: at.temporaryDirectory,
    residueRoot: options.residueRoot ?? at.slot,
    workerPlacement: options.worker ?? false,
    workspaces: at.workspaces,
    runningSince: () => options.runningSince ?? null,
    liveExecutions: () => options.live ?? [],
    device: {
      stat: async () => ({ dev: DEVICE }),
      statfs: async () => ({ blocks: 100, bsize: 10, bavail: 40 }),
    },
    now: () => NOW,
  });
}

function kindOf(
  measurement: FootprintMeasurement,
  kind: InstanceFootprintKind,
) {
  const found = measurement.kinds.find((entry) => entry.kind === kind);
  assert.ok(found);
  return found;
}

function workspace(at: Layout, key: string, bytes: number, when: number) {
  const directory = join(at.workspaces.root, key);
  mkdirSync(directory, { recursive: true });
  file(join(directory, "file"), bytes, when);
  utimesSync(directory, when / 1000, when / 1000);
}

test("a slot measure reports workspace, tool_output, log and slot_residue oldest first with full-walk times", async (t) => {
  const at = layout(t);
  workspace(at, NODE_NEW, NEW_WORKSPACE_BYTES, NOW - DAY_MS);
  workspace(at, NODE_OLD, OLD_WORKSPACE_BYTES, NOW - 40 * DAY_MS);
  file(join(at.temporaryDirectory, OUTPUT_OLD), 3, NOW - 40 * DAY_MS);
  file(join(at.temporaryDirectory, OTHER_FILE), OTHER_BYTES, NOW);
  file(join(at.data, UNIT_LOG), 7, NOW);
  file(join(at.slot, "stderr.log"), 11, NOW);
  mkdirSync(executionSessionRoot(at.data), { recursive: true });
  file(join(executionSessionRoot(at.data), "entry"), 13, NOW);
  const measurement = await footprintOf(at).measure(background.signal);
  assert.equal(measurement.disk, null);
  assert.deepEqual(
    measurement.kinds.map((entry) => entry.kind),
    [
      InstanceFootprintKind.Workspace,
      InstanceFootprintKind.ToolOutput,
      InstanceFootprintKind.Log,
      InstanceFootprintKind.SlotResidue,
    ],
  );
  const workspaces = kindOf(measurement, InstanceFootprintKind.Workspace);
  assert.deepEqual(
    workspaces.items.map((item) => item.key),
    [NODE_OLD, NODE_NEW],
  );
  assert.equal(workspaces.bytes, OLD_WORKSPACE_BYTES + NEW_WORKSPACE_BYTES);
  assert.equal(workspaces.oldest_at, NOW - 40 * DAY_MS);
  assert.equal(workspaces.newest_at, NOW - DAY_MS);
  assert.equal(workspaces.recent_count, ONE_RECENT);
  assert.equal(workspaces.items_complete, true);
  const outputs = kindOf(measurement, InstanceFootprintKind.ToolOutput);
  assert.deepEqual(
    outputs.items.map((item) => item.key),
    [OUTPUT_OLD],
  );
  const logs = kindOf(measurement, InstanceFootprintKind.Log);
  assert.deepEqual(
    logs.items.map((item) => [item.key, item.bytes]),
    [[UNIT_LOG, 7]],
  );
  const residue = kindOf(measurement, InstanceFootprintKind.SlotResidue);
  assert.equal(residue.bytes, OTHER_BYTES);
  assert.deepEqual(residue.items, []);
});

test("a slot measure counts a pool with a tree inside the workspace kind as one item with the newest return time, and an empty pool as no item", async (t) => {
  const at = layout(t);
  workspace(at, NODE_OLD, OLD_WORKSPACE_BYTES, NOW - 40 * DAY_MS);
  const pool = join(at.workspaces.root, POOL_KEY);
  mkdirSync(join(pool, "0".repeat(32), "agent"), { recursive: true });
  const empty = kindOf(
    await footprintOf(at).measure(background.signal),
    InstanceFootprintKind.Workspace,
  );
  assert.deepEqual(
    empty.items.map((item) => item.key),
    [NODE_OLD],
  );
  let metadataBytes = 0;
  for (const [poolClass, returnedAt] of [
    ["agent", NOW - 3 * DAY_MS],
    ["command", NOW - DAY_MS],
  ] as const) {
    const tree = join(pool, "0".repeat(32), poolClass, randomUUID());
    mkdirSync(join(tree, ".git"), { recursive: true });
    file(join(tree, "file"), POOL_TREE_BYTES, NOW - 50 * DAY_MS);
    const metadata = JSON.stringify({ node_id: null, returned_at: returnedAt });
    writeFileSync(join(tree, ".git", "kanthord-pool.json"), metadata);
    metadataBytes += metadata.length;
  }
  const measured = kindOf(
    await footprintOf(at).measure(background.signal),
    InstanceFootprintKind.Workspace,
  );
  assert.deepEqual(
    measured.items.map((item) => [item.key, item.bytes, item.modified_at]),
    [
      [NODE_OLD, OLD_WORKSPACE_BYTES, NOW - 40 * DAY_MS],
      [POOL_KEY, 2 * POOL_TREE_BYTES + metadataBytes, NOW - DAY_MS],
    ],
  );
  assert.equal(measured.count, TWO_ITEMS);
});

test("tool_output keeps only regular files of the name form and skips a symlink", async (t) => {
  const at = layout(t);
  const target = join(at.slot, "target");
  file(target, 9, NOW);
  symlinkSync(target, join(at.temporaryDirectory, OUTPUT_NEW));
  file(join(at.temporaryDirectory, OUTPUT_OLD), 3, NOW);
  file(join(at.temporaryDirectory, OTHER_FILE), OTHER_BYTES, NOW);
  const measurement = await footprintOf(at).measure(background.signal);
  assert.deepEqual(
    kindOf(measurement, InstanceFootprintKind.ToolOutput).items.map(
      (item) => item.key,
    ),
    [OUTPUT_OLD],
  );
});

test("a worker measure reports session and disk, and slot_residue reports <unit>/tmp less the tool_output files", async (t) => {
  const at = layout(t);
  const session = join(executionSessionRoot(at.data), EXECUTION_ENDED);
  mkdirSync(session, { recursive: true });
  file(join(session, "a.jsonl"), 6, NOW - DAY_MS);
  file(join(at.temporaryDirectory, OUTPUT_OLD), 3, NOW);
  file(join(at.temporaryDirectory, OTHER_FILE), OTHER_BYTES, NOW);
  const measurement = await footprintOf(at, {
    worker: true,
    residueRoot: at.temporaryDirectory,
  }).measure(background.signal);
  assert.deepEqual(measurement.disk, {
    device: String(DEVICE),
    total_bytes: 1000,
    free_bytes: 400,
  });
  const sessions = kindOf(measurement, InstanceFootprintKind.Session);
  assert.deepEqual(
    sessions.items.map((item) => [item.key, item.bytes]),
    [[EXECUTION_ENDED, 6]],
  );
  assert.equal(
    kindOf(measurement, InstanceFootprintKind.SlotResidue).bytes,
    OTHER_BYTES,
  );
});

test("a workspace order removes a closed workspace, refuses a held key and answers absent on a repeat", async (t) => {
  const at = layout(t);
  workspace(at, NODE_OLD, 10, NOW - 40 * DAY_MS);
  workspace(at, NODE_NEW, 20, NOW);
  at.workspaces.hold(at.workspaces.nodeKey(NODE_NEW));
  const footprint = footprintOf(at);
  const order = {
    cleanup_id: CLEANUP_ID,
    kind: InstanceCleanableKind.Workspace,
    keys: [NODE_OLD, NODE_NEW],
  };
  assert.deepEqual(await footprint.run(order, background.signal), {
    cleanup_id: CLEANUP_ID,
    removed: [NODE_OLD],
    removed_bytes: 10,
    absent: [],
    refused: [{ key: NODE_NEW, reason: CleanupRefusal.Live }],
  });
  assert.deepEqual(
    await footprint.run({ ...order, keys: [NODE_OLD] }, background.signal),
    {
      cleanup_id: CLEANUP_ID,
      removed: [],
      removed_bytes: 0,
      absent: [NODE_OLD],
      refused: [],
    },
  );
});

test("a running cleanup_id is skipped", async (t) => {
  const at = layout(t);
  const footprint = footprintOf(at);
  const order = {
    cleanup_id: CLEANUP_ID,
    kind: InstanceCleanableKind.ToolOutput,
    keys: [OUTPUT_OLD],
  };
  const first = footprint.run(order, background.signal);
  assert.equal(await footprint.run(order, background.signal), null);
  assert.ok(await first);
});

test("a tool_output order refuses a file at or after the start of the running execution and a symlink", async (t) => {
  const at = layout(t);
  file(join(at.temporaryDirectory, OUTPUT_OLD), 3, NOW - DAY_MS);
  file(join(at.temporaryDirectory, OUTPUT_NEW), 4, NOW);
  const footprint = footprintOf(at, { runningSince: NOW - 1000 });
  assert.deepEqual(
    await footprint.run(
      {
        cleanup_id: CLEANUP_ID,
        kind: InstanceCleanableKind.ToolOutput,
        keys: [OUTPUT_OLD, OUTPUT_NEW],
      },
      background.signal,
    ),
    {
      cleanup_id: CLEANUP_ID,
      removed: [OUTPUT_OLD],
      removed_bytes: 3,
      absent: [],
      refused: [{ key: OUTPUT_NEW, reason: CleanupRefusal.Live }],
    },
  );
});

test("a worker session order refuses the live execution and removes an ended session", async (t) => {
  const at = layout(t);
  for (const execution of [EXECUTION_ENDED, EXECUTION_LIVE]) {
    const session = join(executionSessionRoot(at.data), execution);
    mkdirSync(session, { recursive: true });
    file(join(session, "a.jsonl"), 6, NOW);
  }
  const footprint = footprintOf(at, { worker: true, live: [EXECUTION_LIVE] });
  assert.deepEqual(
    await footprint.run(
      {
        cleanup_id: CLEANUP_ID,
        kind: InstanceCleanableKind.Session,
        keys: [EXECUTION_ENDED, EXECUTION_LIVE],
      },
      background.signal,
    ),
    {
      cleanup_id: CLEANUP_ID,
      removed: [EXECUTION_ENDED],
      removed_bytes: 6,
      absent: [],
      refused: [{ key: EXECUTION_LIVE, reason: CleanupRefusal.Live }],
    },
  );
});

test("a worker session order refuses a symlinked session directory as unreadable and keeps its target", async (t) => {
  const at = layout(t);
  const target = join(at.slot, "outside");
  mkdirSync(target);
  file(join(target, "a.jsonl"), 6, NOW);
  mkdirSync(executionSessionRoot(at.data), { recursive: true });
  symlinkSync(target, join(executionSessionRoot(at.data), EXECUTION_ENDED));
  const footprint = footprintOf(at, { worker: true });
  assert.deepEqual(
    await footprint.run(
      {
        cleanup_id: CLEANUP_ID,
        kind: InstanceCleanableKind.Session,
        keys: [EXECUTION_ENDED],
      },
      background.signal,
    ),
    {
      cleanup_id: CLEANUP_ID,
      removed: [],
      removed_bytes: 0,
      absent: [],
      refused: [{ key: EXECUTION_ENDED, reason: CleanupRefusal.Unreadable }],
    },
  );
  assert.ok(existsSync(join(target, "a.jsonl")));
});
