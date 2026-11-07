import assert from "node:assert/strict";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import type { TestContext } from "node:test";
import {
  ActorKind,
  type DecodedLinkUpdate,
  type ExternalLink,
  ExternalLinkKind,
  InboxReason,
  Intent,
  NodeState,
  RevisionWrite,
} from "./contract.ts";
import { closeAttempt, insertLinkUpdate, openAttempt } from "./record-store.ts";
import {
  insertNode,
  insertRevision,
  readCurrentRevision,
  setNodeState,
} from "./store.ts";
import { controlHarness } from "./test-support.ts";
import type { MissionBindings } from "./contract.ts";

export const LINK_RESOURCE = "conversation:github:acme/app";
export const LINK_NUMBER = 7;
export const OTHER_LINK_NUMBER = 8;
export const LINK_ACTOR = "1001";
export const LINK_UPDATE_KEY = "issue_comment:5001";
export const LINK_OCCURRED_AT = 1700000000000;
export const LINK_EVENT_BODY = "COMMENT BODY OF THE UPDATE";
export const LINK_MENTION = "reviewer";
const NODE_TIME = 100;
const FIRST_REVISION = 1;
export const TRUSTED_ACTOR = "9";
export const INBOX_ACTOR = "583231";
export const INBOX_HANDLE = "ulrich";
type Inbox = { actor_id: string; handle: string };
export const OTHER_ACTOR = "7";
type BindingRevision = NonNullable<
  ReturnType<MissionBindings["getBindingRevision"]>
>;

export function linkOf(number = LINK_NUMBER): ExternalLink {
  return {
    kind: ExternalLinkKind.GitHubIssue,
    resource_identity: LINK_RESOURCE,
    number,
  };
}

export function updateOf(
  overrides: Partial<DecodedLinkUpdate> = {},
): DecodedLinkUpdate {
  return {
    external_link: linkOf(),
    update_key: LINK_UPDATE_KEY,
    actor_id: LINK_ACTOR,
    actor_automated: false,
    occurred_at: LINK_OCCURRED_AT,
    mentions: [LINK_MENTION],
    ...overrides,
  };
}

export function linkUpdateHarness(t: TestContext, identity: CallerIdentity) {
  const h = controlHarness(t, identity);
  const decoding = {
    address: null as ReturnType<typeof h.dependencies.decoder.decode>,
    update: null as DecodedLinkUpdate | null,
    addressCalls: 0,
    updateCalls: 0,
  };
  const intakeChecks: string[] = [];
  const replies = {
    answer: { succeeded: false, pending_actor_ids: [] as string[] },
    inputs: [] as { update_key: string; external_link: ExternalLink }[],
  };
  h.dependencies.intakeLinks.replyMatch = async (_context, input) => {
    replies.inputs.push(input);
    return replies.answer;
  };
  h.dependencies.decoder = {
    decode: () => {
      decoding.addressCalls++;
      return decoding.address;
    },
    decodeLinkUpdate: () => {
      decoding.updateCalls++;
      return decoding.update;
    },
  };
  h.dependencies.intakeCheck.check = (_context, evidenceId) => {
    intakeChecks.push(evidenceId);
    return Promise.reject(new Error("A link update calls no Intake check."));
  };
  const addNode = (
    links: ExternalLink[],
    state: NodeState = NodeState.Available,
    bindings: string[] = [],
  ) => {
    const nodeId = createIdentity("node");
    const filename = `${nodeId.toLowerCase()}.md`;
    h.store.transaction((tx) => {
      insertNode(tx, {
        id: nodeId,
        mission_id: h.mission_id,
        filename,
        created_at: NODE_TIME,
      });
      insertRevision(tx, {
        node_id: nodeId,
        revision: FIRST_REVISION,
        filename,
        reason: "plan",
        actor: h.actor,
        created_at: NODE_TIME,
        content: {
          name: "Name",
          requirement: "Requirement",
          criterion: "Criterion",
          verifications: ["true"],
          bindings,
          intent: Intent.Examine,
          tags: [],
          external_links: links,
        },
        tasks: [],
        change: {
          write: RevisionWrite.NodeCreate,
          previous_revision: null,
          changed_fields: [],
        },
        pinned_by_attempts: [],
      });
      if (state === NodeState.Executing)
        openAttempt(
          tx,
          nodeId,
          FIRST_REVISION,
          { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" },
          NODE_TIME,
        );
      setNodeState(tx, nodeId, state);
    });
    return nodeId;
  };
  const addAttempts = (nodeId: string, count: number) =>
    h.store.transaction((tx) => {
      for (let attempt = 1; attempt <= count; attempt++) {
        openAttempt(
          tx,
          nodeId,
          FIRST_REVISION,
          { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" },
          NODE_TIME,
        );
        closeAttempt(tx, nodeId, attempt, NODE_TIME);
      }
    });
  const proposals = () =>
    h.store.database
      .prepare("SELECT * FROM mission_proposal ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  const pinned: BindingRevision[] = [];
  const reads: string[] = [];
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => {
    reads.push(bindingId);
    return pinned.find((binding) => binding.binding_id === bindingId) ?? null;
  };
  const addBinding = (
    resource: string,
    actorIds: string[] | undefined,
    revision = FIRST_REVISION,
    inbox?: Inbox,
  ) => {
    const bindingId = createIdentity("binding");
    pinned.push({
      project_id: h.project_id,
      binding_id: bindingId,
      name: `binding_${pinned.length}`,
      resource_identity: resource,
      revision,
      tombstone: false,
      disabled: false,
      ...(actorIds === undefined
        ? {}
        : { link_trust: { actor_ids: actorIds } }),
      ...(inbox === undefined ? {} : { inbox }),
    });
    return bindingId;
  };
  const current: { value: { binding_id: string; inbox: Inbox } | null } = {
    value: null,
  };
  h.dependencies.bindings.conversationInboxOf = (_tx, projectId, resource) => {
    assert.equal(projectId, h.project_id);
    return resource === LINK_RESOURCE ? current.value : null;
  };
  const writeInbox = (inbox: Inbox | null, revision = FIRST_REVISION) => {
    const bindingId = addBinding(
      LINK_RESOURCE,
      undefined,
      revision,
      inbox ?? undefined,
    );
    current.value = inbox === null ? null : { binding_id: bindingId, inbox };
    return bindingId;
  };
  const insertUpdate = (
    link: ExternalLink,
    actorId: string,
    occurredAt: number,
    updateKey = `issue_comment:${occurredAt}:${actorId}`,
    inbox: { reason: InboxReason; binding_id: string | null } = {
      reason: InboxReason.Linked,
      binding_id: null,
    },
  ) =>
    h.store.transaction((tx) =>
      insertLinkUpdate(tx, {
        mission_id: h.mission_id,
        external_link: canonicalJSON(link),
        update_key: updateKey,
        inbound_event_id: createIdentity("inbound_event"),
        actor_id: actorId,
        occurred_at: occurredAt,
        ...inbox,
        done_at: null,
        snoozed_until: null,
      }),
    );
  const listed = () =>
    h.invoke("link_update.list", {
      params: { node_id: h.node_id },
      query: {},
      body: null,
    });
  const listedOf = (nodeId: string, query: object = {}) =>
    h.invoke("link_update.list", {
      params: { node_id: nodeId },
      query,
      body: null,
    });
  const currentRevision = (nodeId: string) =>
    h.store.transaction((tx) => readCurrentRevision(tx, nodeId)!.revision);
  const retire = (nodeId: string) =>
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(NODE_TIME, nodeId),
    );
  const admit = (inboundEventId = createIdentity("inbound_event")) =>
    h.invoke("delivery.admit", {
      params: {},
      query: {},
      body: {
        inbound_event_id: inboundEventId,
        project_id: h.project_id,
        platform: "github",
        resource: LINK_RESOURCE,
        event: Buffer.from(LINK_EVENT_BODY).toString("base64"),
        metadata: { event: "issue_comment" },
      },
    });
  const rows = () =>
    h.store.database
      .prepare("SELECT * FROM mission_link_update ORDER BY rowid")
      .all()
      .map((row) => ({ ...row }));
  return {
    ...h,
    decoding,
    replies,
    intakeChecks,
    addNode,
    addAttempts,
    proposals,
    addBinding,
    writeInbox,
    insertUpdate,
    listed,
    listedOf,
    currentRevision,
    reads,
    retire,
    admit,
    rows,
  };
}
