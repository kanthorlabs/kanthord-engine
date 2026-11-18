import { z } from "zod";
import type { HumanIdentity } from "../kernel/caller.ts";
import type { CancellationContext } from "../kernel/context.ts";
import { timestamp } from "../kernel/json.ts";
import { OperationResultType } from "../kernel/operation.ts";
import {
  importResultSchema,
  missionOperations,
  nodeChangeSchema,
  NodeState,
} from "../mission/contract.ts";
import {
  AuthorKind,
  type MemberEntry,
  type NoticeRecord,
  type SessionEntry,
  WORKBENCH_WATCH_CHECK_MS,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { recordOf } from "./sessions.ts";
import type { InvokeOperation } from "./tools.ts";

const LAST = -1;
const NO_ITEMS = 0;
const AFTER_ENTRY = 1;
const MESSAGE_ENTRY = "message";
const USER_ROLE = "user";
const BLOCK_SEPARATOR = "; ";
const NAME_SEPARATOR = " · ";
const STAT_SEPARATOR = ", ";
const COMPLETED_PREFIX = "Completed: ";
const OUTCOME_LIMIT = 1;
const FIRST_ITEM = 0;
const STAT_STATES = [NodeState.Completed, NodeState.Discarded] as const;

type NoticeBlock = NoticeRecord["projects"][number];
type NoticeNode = NoticeBlock["nodes"][number];

const nodeFactsSchema = z.looseObject({
  state: z.string(),
  retired_at: timestamp.nullable(),
  content: z.looseObject({ name: z.string() }),
});

const outcomePageSchema = z.looseObject({
  items: z.array(z.looseObject({ created_at: timestamp })),
});

export function createdNodeIds(operationId: string, data: unknown): string[] {
  const change = changeOf(operationId, data);
  if (change === null) return [];
  return change.revisions.flatMap((revision) =>
    revision.change.previous_revision === null ? [revision.node_id] : [],
  );
}

function changeOf(operationId: string, data: unknown) {
  if (operationId === missionOperations["node.create"].id) {
    const parsed = nodeChangeSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  }
  if (operationId === missionOperations["import.apply"].id) {
    const parsed = importResultSchema.safeParse(data);
    return parsed.success ? parsed.data.changes : null;
  }
  return null;
}

export function openWatch(entries: readonly SessionEntry[]): {
  nodeIds: string[];
  lastWatchEntryId: string | null;
} {
  const records = entries.map((entry) => ({ entry, record: recordOf(entry) }));
  const notices = records.flatMap(({ record }) =>
    record?.kind === WorkbenchRecordKind.Notice ? [record] : [],
  );
  const lastNotice = notices.at(LAST);
  const from =
    lastNotice === undefined
      ? 0
      : entries.findIndex((entry) => entry.id === lastNotice.watch_entry_id) +
        AFTER_ENTRY;
  const watches = records
    .slice(from)
    .flatMap(({ entry, record }) =>
      record?.kind === WorkbenchRecordKind.Watch ? [{ entry, record }] : [],
    );
  return {
    nodeIds: [...new Set(watches.flatMap(({ record }) => record.node_ids))],
    lastWatchEntryId: watches.at(LAST)?.entry.id ?? null,
  };
}

interface OwnerCheck {
  pendingGuest: Map<string, boolean>;
  ownerTimes: number[];
  notice: { record: NoticeRecord; at: number } | null;
}

function isUserMessage(entry: SessionEntry): boolean {
  const message = entry.message as { role?: unknown } | undefined;
  return entry.type === MESSAGE_ENTRY && message?.role === USER_ROLE;
}

function scan(state: OwnerCheck, entry: MemberEntry): void {
  const at = Date.parse(entry.timestamp);
  const record: WorkbenchRecord | null = recordOf(entry);
  if (record?.kind === WorkbenchRecordKind.Notice) {
    state.notice = { record, at };
    return;
  }
  if (record?.kind === WorkbenchRecordKind.Author) {
    state.pendingGuest.set(
      entry.session_id,
      record.author.kind === AuthorKind.Guest,
    );
    return;
  }
  if (record?.kind === WorkbenchRecordKind.Note) {
    if (record.author.kind === AuthorKind.Owner) state.ownerTimes.push(at);
    return;
  }
  if (!isUserMessage(entry)) return;
  const guest = state.pendingGuest.get(entry.session_id) === true;
  state.pendingGuest.delete(entry.session_id);
  if (!guest) state.ownerTimes.push(at);
}

export function pendingNotice(
  entries: readonly MemberEntry[],
): NoticeRecord | null {
  const state: OwnerCheck = {
    pendingGuest: new Map(),
    ownerTimes: [],
    notice: null,
  };
  for (const entry of entries) scan(state, entry);
  const { notice, ownerTimes } = state;
  if (notice === null) return null;
  return ownerTimes.some((at) => at > notice.at) ? null : notice.record;
}

export function noticeStats(block: NoticeBlock): string {
  return STAT_STATES.flatMap((state) => {
    const count = block.nodes.filter((node) => node.state === state).length;
    return count === NO_ITEMS ? [] : [`${count} ${state}`];
  }).join(STAT_SEPARATOR);
}

export function noticeLine(block: NoticeBlock): string {
  return `${COMPLETED_PREFIX}${block.name}${NAME_SEPARATOR}${noticeStats(block)}`;
}

export function noticeSummary(record: NoticeRecord): string {
  return record.projects
    .map((block) => `${block.name}${NAME_SEPARATOR}${noticeStats(block)}`)
    .join(BLOCK_SEPARATOR);
}

export interface WatchConversation {
  id: string;
  entries(): readonly SessionEntry[];
  append(record: WorkbenchRecord): void;
}

export interface WatchCheckOptions {
  identity: HumanIdentity;
  context: CancellationContext;
}

export interface WatchCheckerDependencies {
  invoke: InvokeOperation;
  projectOf(prefix: "node", id: string): string | null;
  projectNames(ids: readonly string[]): ReadonlyMap<string, string>;
  now?: () => number;
}

interface ReadNode {
  node_id: string;
  name: string;
  state: NoticeNode["state"];
}

export class WatchChecker {
  private readonly running = new Map<string, Promise<void>>();
  private readonly started = new Map<string, number>();
  private readonly dependencies: WatchCheckerDependencies;
  private readonly now: () => number;

  constructor(dependencies: WatchCheckerDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
  }

  async check(
    conversation: WatchConversation,
    options: WatchCheckOptions,
  ): Promise<void> {
    const current = this.running.get(conversation.id);
    if (current !== undefined) return current;
    const open = openWatch(conversation.entries());
    if (open.nodeIds.length === NO_ITEMS) return;
    const last = this.started.get(conversation.id);
    const start = this.now();
    if (last !== undefined && start - last < WORKBENCH_WATCH_CHECK_MS) return;
    this.started.set(conversation.id, start);
    const run = this.run(conversation, options, open);
    this.running.set(conversation.id, run);
    try {
      await run;
    } finally {
      this.running.delete(conversation.id);
    }
  }

  private async run(
    conversation: WatchConversation,
    options: WatchCheckOptions,
    open: ReturnType<typeof openWatch>,
  ): Promise<void> {
    const projects = await this.gather(open.nodeIds, options).catch(() => null);
    if (projects === null || open.lastWatchEntryId === null) return;
    conversation.append({
      kind: WorkbenchRecordKind.Notice,
      watch_entry_id: open.lastWatchEntryId,
      projects,
    });
  }

  private async gather(
    nodeIds: readonly string[],
    options: WatchCheckOptions,
  ): Promise<NoticeBlock[] | null> {
    const nodes: ReadNode[] = [];
    for (const nodeId of nodeIds) {
      const facts = await this.readNode(nodeId, options);
      if (facts.retired_at !== null) continue;
      if (!isEnded(facts.state)) return null;
      nodes.push({
        node_id: nodeId,
        name: facts.content.name,
        state: facts.state,
      });
    }
    if (nodes.length === NO_ITEMS) return null;
    const ended = new Map<string, number>();
    for (const node of nodes)
      ended.set(node.node_id, await this.endedAt(node.node_id, options));
    return this.blocksOf(nodes, ended);
  }

  private blocksOf(
    nodes: readonly ReadNode[],
    ended: ReadonlyMap<string, number>,
  ): NoticeBlock[] {
    const projectIds = nodes.map(({ node_id }) => this.projectIdOf(node_id));
    const names = this.dependencies.projectNames([...new Set(projectIds)]);
    const blocks = new Map<string, NoticeBlock>();
    nodes.forEach((node, index) => {
      const projectId = projectIds[index]!;
      const name = names.get(projectId);
      if (name === undefined) throw new Error("A watched project has no name.");
      const block = blocks.get(projectId) ?? {
        project_id: projectId,
        name,
        nodes: [],
      };
      block.nodes.push({
        node_id: node.node_id,
        name: node.name,
        state: node.state,
        ended_at: ended.get(node.node_id)!,
      });
      blocks.set(projectId, block);
    });
    return [...blocks.values()];
  }

  private projectIdOf(nodeId: string): string {
    const projectId = this.dependencies.projectOf("node", nodeId);
    if (projectId === null) throw new Error("A watched node has no project.");
    return projectId;
  }

  private async readNode(nodeId: string, options: WatchCheckOptions) {
    const data = await this.invoke(
      missionOperations["node.get"],
      { params: { node_id: nodeId }, query: {}, body: null },
      options,
    );
    return nodeFactsSchema.parse(data);
  }

  private async endedAt(
    nodeId: string,
    options: WatchCheckOptions,
  ): Promise<number> {
    const data = await this.invoke(
      missionOperations["outcome.list"],
      {
        params: { node_id: nodeId },
        query: { limit: OUTCOME_LIMIT },
        body: null,
      },
      options,
    );
    const newest = outcomePageSchema.parse(data).items[FIRST_ITEM];
    if (newest === undefined) throw new Error("A watched node has no outcome.");
    return newest.created_at;
  }

  private async invoke(
    operation: (typeof missionOperations)["node.get" | "outcome.list"],
    input: unknown,
    options: WatchCheckOptions,
  ): Promise<unknown> {
    const result = await this.dependencies.invoke(operation, input, {
      identity: options.identity,
      context: options.context,
    });
    if (result.type !== OperationResultType.Completed)
      throw new Error(`${operation.id}: the read did not complete.`);
    return result.data;
  }
}

function isEnded(state: string): state is NoticeNode["state"] {
  return (STAT_STATES as readonly string[]).includes(state);
}
