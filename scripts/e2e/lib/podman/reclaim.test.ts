import test from "node:test";
import assert from "node:assert/strict";

import { reclaimByLabel, runLabel } from "./reclaim.ts";
import type { CommandRecord } from "../command.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

const runId = "R1";
const filterFlag = `label=${runLabel}=${runId}`;

const kindOrder = [
  "container",
  "pod",
  "secret",
  "volume",
  "network",
  "image",
] as const;

type Kind = (typeof kindOrder)[number];

const listArgv: Readonly<Record<Kind, readonly string[]>> = {
  container: ["podman", "ps", "--all", "--quiet", "--filter", filterFlag],
  pod: ["podman", "pod", "ps", "--quiet", "--filter", filterFlag],
  secret: ["podman", "secret", "ls", "--quiet", "--filter", filterFlag],
  volume: ["podman", "volume", "ls", "--quiet", "--filter", filterFlag],
  network: ["podman", "network", "ls", "--quiet", "--filter", filterFlag],
  image: ["podman", "image", "ls", "--quiet", "--filter", filterFlag],
};

// Only `podman rm` accepts `--filter`. `podman pod rm`, `secret rm`,
// `volume rm`, `network rm` and `image rm` all reject it (exit 125, `unknown
// flag: --filter`), so those five take the ids parsed from that kind's list
// as their remove command's arguments instead.
const removePrefix: Readonly<Record<Kind, readonly string[]>> = {
  container: ["podman", "rm", "--force", "--filter", filterFlag],
  pod: ["podman", "pod", "rm", "--force"],
  secret: ["podman", "secret", "rm"],
  volume: ["podman", "volume", "rm", "--force"],
  network: ["podman", "network", "rm", "--force"],
  image: ["podman", "image", "rm", "--force"],
};

function removeArgvFor(kind: Kind, ids: readonly string[]): readonly string[] {
  return kind === "container"
    ? removePrefix.container
    : [...removePrefix[kind], ...ids];
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function matchesKind(
  argv: readonly string[],
  table: Readonly<Record<Kind, readonly string[]>>,
): Kind | null {
  for (const kind of kindOrder) {
    if (
      table[kind].length === argv.length &&
      table[kind].every((token, index) => argv[index] === token)
    ) {
      return kind;
    }
  }
  return null;
}

// Rejects the exact class of defect this suite is guarding against: a remove
// argv for any kind other than the plain `podman rm` that still carries a
// flag (chiefly `--filter`) among what should be its trailing id arguments.
// Real podman exits 125 on such a command; this throws, so a fake executor
// can never again answer a shape podman itself would refuse.
function matchesRemoveKind(argv: readonly string[]): Kind | null {
  if (arraysEqual(argv, removePrefix.container)) {
    return "container";
  }
  for (const kind of kindOrder) {
    if (kind === "container") {
      continue;
    }
    const prefix = removePrefix[kind];
    if (
      argv.length >= prefix.length &&
      prefix.every((token, index) => argv[index] === token)
    ) {
      const extra = argv.slice(prefix.length);
      if (extra.some((token) => token.startsWith("--"))) {
        throw new Error(
          `podman ${kind} rm does not accept a flag among its arguments: ${extra.join(" ")}`,
        );
      }
      return kind;
    }
  }
  return null;
}

function record(argv: readonly string[], stdout: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout, stderr: "" };
}

type ExecutorOptions = Readonly<{
  ids?: Partial<Record<Kind, readonly string[]>>;
  failRemoveOnce?: readonly Kind[];
  survives?: Partial<Record<Kind, readonly string[]>>;
}>;

function fakeExecutor(
  options: ExecutorOptions,
): PodmanExecutor & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const removeAttempts: Partial<Record<Kind, number>> = {};
  const listCallCount: Partial<Record<Kind, number>> = {};

  const executor = Object.assign(
    async (argv: readonly string[]): Promise<CommandRecord> => {
      calls.push(argv);

      const listKind = matchesKind(argv, listArgv);
      if (listKind !== null) {
        const callNumber = (listCallCount[listKind] ?? 0) + 1;
        listCallCount[listKind] = callNumber;
        if (callNumber === 1) {
          const ids = options.ids?.[listKind] ?? [];
          return record(argv, ids.length === 0 ? "" : `${ids.join("\n")}\n`);
        }
        const survivingIds = options.survives?.[listKind] ?? [];
        return record(
          argv,
          survivingIds.length === 0 ? "" : `${survivingIds.join("\n")}\n`,
        );
      }

      const removeKind = matchesRemoveKind(argv);
      if (removeKind !== null) {
        const attempt = (removeAttempts[removeKind] ?? 0) + 1;
        removeAttempts[removeKind] = attempt;
        if (
          attempt === 1 &&
          (options.failRemoveOnce ?? []).includes(removeKind)
        ) {
          throw new Error(`podman ${removeKind} rm failed`);
        }
        return record(argv, "");
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
    { calls },
  );

  return executor;
}

test("reclaimByLabel issues the six list commands and the six remove commands, in the exact order, followed by a re-list", async () => {
  const idsByKind: Readonly<Record<Kind, readonly string[]>> = {
    container: ["c1"],
    pod: ["p1"],
    secret: ["s1"],
    volume: ["v1"],
    network: ["n1"],
    image: ["i1"],
  };
  const executor = fakeExecutor({ ids: idsByKind });

  const report = await reclaimByLabel(executor, runId);

  assert.equal(executor.calls.length, 18);
  for (let index = 0; index < kindOrder.length; index += 1) {
    const kind = kindOrder[index] as Kind;
    assert.deepEqual(executor.calls[index * 3], listArgv[kind]);
    assert.deepEqual(
      executor.calls[index * 3 + 1],
      removeArgvFor(kind, idsByKind[kind]),
    );
    assert.deepEqual(executor.calls[index * 3 + 2], listArgv[kind]);
  }
  assert.equal(report.failed.length, 0);
});

test("an empty list for every kind issues the six list commands and no remove command, and resolves { reclaimed: [], failed: [] }", async () => {
  const executor = fakeExecutor({});

  const report = await reclaimByLabel(executor, runId);

  assert.equal(executor.calls.length, 6);
  for (const argv of executor.calls) {
    const listKind = matchesKind(argv, listArgv);
    assert.notEqual(listKind, null);
  }
  assert.deepEqual(report, { reclaimed: [], failed: [] });
});

test("a stale run: the list commands return ids, the re-list returns empty, and reclaimed holds { kind, id } for each", async () => {
  const executor = fakeExecutor({
    ids: {
      container: ["c1", "c2"],
      pod: ["p1"],
    },
  });

  const report = await reclaimByLabel(executor, runId);

  assert.deepEqual(
    [...report.reclaimed].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    ),
    [
      { kind: "container", id: "c1" },
      { kind: "container", id: "c2" },
      { kind: "pod", id: "p1" },
    ],
  );
  assert.deepEqual(report.failed, []);
});

test("a remove that fails once and succeeds on the repeat resolves with the id in reclaimed", async () => {
  const executor = fakeExecutor({
    ids: { container: ["c1"] },
    failRemoveOnce: ["container"],
  });

  const report = await reclaimByLabel(executor, runId);

  assert.deepEqual(report.reclaimed, [{ kind: "container", id: "c1" }]);
  assert.deepEqual(report.failed, []);

  const containerRemoveCalls = executor.calls.filter(
    (argv) => matchesRemoveKind(argv) === "container",
  );
  assert.equal(containerRemoveCalls.length, 2);
});

test("a remove that exits zero while the re-list still returns the id puts it in failed", async () => {
  const executor = fakeExecutor({
    ids: { container: ["c1"] },
    survives: { container: ["c1"] },
  });

  const report = await reclaimByLabel(executor, runId);

  assert.deepEqual(report.failed, [{ kind: "container", id: "c1" }]);
  assert.deepEqual(report.reclaimed, []);
});

test("two kinds returning the same id string produce two distinct outcomes, one per kind", async () => {
  const executor = fakeExecutor({
    ids: { container: ["x1"], pod: ["x1"] },
    survives: { container: ["x1"], pod: ["x1"] },
  });

  const report = await reclaimByLabel(executor, runId);

  assert.deepEqual(
    [...report.failed].sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: "container", id: "x1" },
      { kind: "pod", id: "x1" },
    ],
  );
});

test("reclaimByLabel itself never throws for a removal failure; the decision belongs to the caller", async () => {
  const executor = fakeExecutor({
    ids: { volume: ["v1"] },
    survives: { volume: ["v1"] },
  });

  await assert.doesNotReject(reclaimByLabel(executor, runId));
});

test("a non-container remove argv that still carries --filter is rejected, and the surviving id is reported as failed rather than falsely reclaimed", async () => {
  const executor = fakeExecutor({
    ids: { volume: ["v1"] },
    survives: { volume: ["v1"] },
  });

  const report = await reclaimByLabel(executor, runId);

  assert.deepEqual(report.failed, [{ kind: "volume", id: "v1" }]);
  assert.deepEqual(report.reclaimed, []);
});
