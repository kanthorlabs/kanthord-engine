import assert from "node:assert/strict";
import { stringify } from "yaml";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type ExportAnswer,
  type ExportEntry,
  ImportFormat,
  type MissionBindings,
  MissionErrorCode,
} from "./contract.ts";
import { revisionFromRow } from "./revision.ts";
import {
  type NodeRow,
  readCurrentRevision,
  readDependencies,
  readMissionNodes,
} from "./store.ts";
import { requireMission } from "./write.ts";

const EXPORT_MAX_BYTES = 10485760;
const TEXT_ENCODING = "utf8";

export function serializePlanFile(entry: ExportEntry): string {
  const front = stringify({
    id: entry.id,
    ...("node" in entry
      ? { node: entry.node }
      : {
          intent: entry.intent,
          depends_on: entry.depends_on,
          tags: entry.tags,
          ...(entry.commit_type === undefined
            ? {}
            : { commit_type: entry.commit_type }),
        }),
    bindings: entry.bindings,
    verifications: entry.verifications,
  });
  return `---\n${front}---\n# ${entry.name}\n\n## Requirement\n\n${entry.requirement}\n\n## Criterion\n\n${entry.criterion}\n`;
}

function exportEntry(
  tx: Transaction,
  node: NodeRow,
  nodes: Map<string, NodeRow>,
  dependencies: Map<string, string[]>,
  bindings: MissionBindings,
): ExportEntry[] {
  const row = readCurrentRevision(tx, node.id);
  assert.ok(row, "A current node has a revision.");
  const record = revisionFromRow(tx, row);
  const content = record.content;
  const names = content.bindings.map((id) => {
    const binding = bindings.getBindingRevision(tx, id);
    if (binding === null) throw new Error(`Missing binding revision: ${id}`);
    return binding.name;
  });
  const dependsOn = (dependencies.get(node.id) ?? []).flatMap((id) => {
    const target = nodes.get(id);
    return target === undefined ? [] : [target.filename];
  });
  dependsOn.sort();
  return [
    {
      filename: node.filename,
      id: node.id,
      ...content,
      depends_on: dependsOn,
      bindings: names,
    },
    ...record.tasks.map((task) => ({
      filename: task.filename,
      id: task.id,
      node: node.filename,
      ...task.content,
    })),
  ];
}

export function exportMission(
  tx: Transaction,
  missionId: string,
  format: ImportFormat,
  bindings: MissionBindings,
): ExportAnswer {
  const mission = requireMission(tx, missionId);
  const nodes = new Map(
    readMissionNodes(tx, missionId)
      .filter((node) => node.retired_at === null)
      .map((node) => [node.id, node]),
  );
  const dependencies = new Map<string, string[]>();
  for (const edge of readDependencies(tx, missionId)) {
    const targets = dependencies.get(edge.dependent) ?? [];
    targets.push(edge.depends_on);
    dependencies.set(edge.dependent, targets);
  }
  const entries = [...nodes.values()]
    .flatMap((node) => exportEntry(tx, node, nodes, dependencies, bindings))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const base = { mission_id: mission.id, mission_version: mission.version };
  const answer: ExportAnswer =
    format === ImportFormat.Json
      ? { ...base, entries }
      : {
          ...base,
          files: entries.map((entry) => ({
            filename: entry.filename,
            content: serializePlanFile(entry),
          })),
        };
  if (
    Buffer.byteLength(JSON.stringify(answer), TEXT_ENCODING) > EXPORT_MAX_BYTES
  )
    throw new OperationError(
      HttpStatus.PayloadTooLarge,
      MissionErrorCode.ExportTooLarge,
      "Mission export exceeds the size limit.",
    );
  return answer;
}
