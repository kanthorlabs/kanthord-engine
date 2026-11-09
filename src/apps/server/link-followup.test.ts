import assert from "node:assert/strict";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  OutboundOperation,
  OutboundRequestState,
  ResourceKind,
} from "../../intake/contract.ts";
import { background } from "../../kernel/context.ts";
import { ExternalLinkKind } from "../../kernel/external-link.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  AdmissionRefusal,
  AssessmentResult,
  AssetKind,
  ConversationAction,
  Disposition,
  EndState,
  type Evidence,
  ExpectedEndState,
  type ExternalAction,
  ImportFormat,
  InboxItemState,
  InboxReason,
  Intent,
  MissionErrorCode,
  missionOperations,
  NodeState,
  PlatformAddressKind,
  Resolution,
} from "../../mission/contract.ts";
import { workerResourceIdentity } from "../../project/contract.ts";
import {
  commentUser,
  LISTED_EVENT,
  listedComment,
} from "../../repository/github-comment-test-support.ts";
import { ReviewState } from "../../repository/github.ts";
import {
  type ExecutionRecord,
  schedulerOperations,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import { SensitiveRule, tracerMarker } from "../../agent/sensitive-text.ts";
import { plainHandoverPayloadSchema } from "../../custody/contract.ts";
import { executionCredentialStore } from "../../custody/index.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import {
  ActionResultKind,
  InstancePlacement,
  type RepositoryTransport,
  workerOperations,
} from "../../worker/contract.ts";
import {
  handedSshAccess,
  runNativeExecution,
  WorkspaceRoot,
} from "../../worker/unit/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  remapOrigin,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { unusedHostTools } from "../../worker/test-support.ts";
import {
  cliSession,
  completed,
  createCredentials,
  repositoryBinding,
  repositorySnapshot,
  until,
} from "./cli-test-support.ts";
import {
  bareRepository,
  createInstancesByCli,
  fakeGitHub,
  gatewayFixture,
  instanceNames,
  mappedTransport,
} from "./test-support.ts";

const TIMEOUT = 180000;
const POLL_INTERVAL_MS = 50;
const GITHUB_KEY = "link_followup_github_key";
const OWNER = "acme";
const REPO = "app";
const REPOSITORY = `${OWNER}/${REPO}`;
const CONVERSATION_RESOURCE = `conversation:github:${REPOSITORY}`;
const OTHER_RESOURCE = "conversation:github:acme/other";
const ENGINE = "engine";
const ISSUES = "acme-issues";
const GENERAL = "general";
const REVIEW = "review";
const LLM_KEY = "link_followup_llm_key";
const ZERO_BYTE = 0;
const DEFAULTS = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
};
const EXTERNAL_LINKS_FIELD = "external_links";
const TRUSTED_ACTOR = "9";
const TRUSTED_LOGIN = "user-9";
const OTHER_ACTOR = "7";
const INBOX_ACTOR = "583231";
const INBOX_HANDLE = "ulrich";
const TRUSTED_USER = 9;
const OTHER_USER = 7;
const INBOX_USER = 583231;
const BOT_USER = 41898282;
const BOT_TYPE = "Bot";
const USER_TYPE = "User";
const LINKED_ISSUE = 117;
const MENTION_ISSUE = 118;
const UNMATCHED_ISSUE = 119;
const FIRST_COMMENT_ID = 7000;
const BASE_TIME = Date.UTC(2026, 10, 7, 4, 0, 0);
const COMMENT_STEP_MS = 1000;
const FIRST_BINDING_SET = 1;
const FIRST_ATTEMPT = 1;
const FIRST_REVISION = 1;
const SECOND_ATTEMPT = 2;
const SECOND_REVISION = 2;
const FIRST_ITEM = 0;
const NO_ITEMS = 0;
const SINGLE_ITEM = 1;
const PAIR = 2;
const MS_PER_DAY = 86400000;
const NO_COUNT = 0;
const SECRET_BODY = `rotate ${"AK" + "IA" + "A".repeat(16)} soon`;
const REDACTED_BODY = `rotate ${tracerMarker(SensitiveRule.AwsAccessKeyId)} soon`;
const RELEASED = { kind: "released", furtherWork: false };
const OTHER_BODY = "Is this ready?";
const MERGE_COMMIT = "c".repeat(40);
const LINK = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: CONVERSATION_RESOURCE,
  number: LINKED_ISSUE,
};
const NODE_FILENAME = "follow-the-issue.md";
const PLAIN_FILENAME = "plain.md";
const COMMENTS_PATH = /^\/repos\/acme\/app\/issues\/comments(\?|$)/;
const POSTED_PATH = /^\/repos\/acme\/app\/issues\/117\/comments$/;

type Page<T> = { items: T[] };
type Binding = { id: string; name: string; resource_identity: string };
type Row = {
  id: string;
  update_key: string;
  actor_id: string;
  reason: string;
  binding_id: string | null;
  done_at: number | null;
  snoozed_until: number | null;
};
type Event = { event_id: string; state: string };

function refused<T>(result: OperationResult<T>, status: number, code: string) {
  assert.ok(
    result.type === OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  return result.error.error;
}

test(
  "a GitHub issue follow-up and the inbox run through the composed server",
  { timeout: TIMEOUT },
  async (t) => {
    const gitHub = await fakeGitHub(t);
    gitHub.replyAccount(INBOX_USER, INBOX_HANDLE);
    const engineBare = await bareRepository(t, ENGINE);
    const fixture = await gatewayFixture(t, {
      fakeSlots: true,
      repositoryConnector: { gitLsRemote: async () => {} },
      github: { baseUrl: gitHub.endpoint, mergeabilityRetryDelayMs: 1 },
      intake: { pollIntervalMs: POLL_INTERVAL_MS },
      repositoryTransport: mappedTransport({
        [`git@github.com:owner/${ENGINE}.git`]: engineBare.bare,
      }),
    });
    const session = cliSession(t, fixture.endpoint, fixture.token, GITHUB_KEY);
    await createCredentials(session, GITHUB_KEY);
    session.secrets.push(LLM_KEY);
    await session.write(["llm", "credential", "create"], {
      name: "anthro-1",
      platform: "anthropic",
      metadata: null,
      secret: { key: LLM_KEY },
    });
    for (const agent of ["swe@1", "re@1"])
      await session.write(["agent", "enablement", "put", agent], {
        agent_providers: [
          { name: "default", provider: "anthropic", credential: "anthro-1" },
        ],
        default_configuration: DEFAULTS,
        fallback_configurations: [],
      });
    const generalInstances = await createInstancesByCli(
      session.read,
      instanceNames(GENERAL, SINGLE_ITEM),
    );
    const reviewInstances = await createInstancesByCli(
      session.read,
      instanceNames(REVIEW, SINGLE_ITEM),
      InstancePlacement.Server,
      "reviewer@1",
    );
    const mission = httpClient(
      missionOperations,
      fixture.endpoint,
      fixture.token,
    );
    const service = directClient(missionOperations, fixture.invocation);
    const intakeIdentity = mintServiceIdentity(INTAKE_SERVICE_NAME);
    const write = () => ({ idempotencyKey: createIdempotencyKey() });
    const project = await session.read<{ id: string }>([
      "project",
      "create",
      "--name",
      "links",
    ]);
    const { id: missionId } = await session.read<{ id: string }>([
      "mission",
      "get",
      project.id,
    ]);
    const missionVersion = async () =>
      (await session.read<{ version: number }>(["mission", "get", project.id]))
        .version;
    const bindingSet = (trusted: string[]) => ({
      [GENERAL]: {
        kind: "worker",
        config: {
          worker: "coder@1",
          worker_instances: generalInstances,
          entries: [{ agent: "swe@1", ...DEFAULTS }],
        },
      },
      [REVIEW]: {
        kind: "worker",
        config: {
          worker: "reviewer@1",
          worker_instances: reviewInstances,
          entries: [{ agent: "re@1", ...DEFAULTS }],
        },
      },
      [ENGINE]: {
        ...repositoryBinding(ENGINE, "pull_request"),
        config: {
          ...repositoryBinding(ENGINE, "pull_request").config,
          link_trust: { actor_ids: [TRUSTED_ACTOR] },
        },
      },
      [ISSUES]: {
        kind: "conversation",
        config: {
          available: true,
          platform: InboundPlatform.GitHub,
          repository: REPOSITORY,
          credential: "github",
          link_trust: { actor_ids: trusted },
          inbox: { actor_id: INBOX_ACTOR, handle: INBOX_HANDLE },
          reply_policy: { follows: { type: "assessment_passed" } },
        },
      },
    });
    const bindingsOf = async () => {
      const page = await session.read<Page<Binding>>([
        "project",
        "binding",
        "list",
        project.id,
      ]);
      return (name: string) => {
        const found = page.items.find((item) => item.name === name);
        assert.ok(found);
        return found;
      };
    };
    const firstApplied = await session.write<{ binding_set_version: number }>(
      ["project", "binding", "apply", project.id],
      { version: FIRST_BINDING_SET, bindings: bindingSet([TRUSTED_ACTOR]) },
    );
    const firstBindings = await bindingsOf();

    const entry = (links: unknown[]) => ({
      filename: NODE_FILENAME,
      intent: Intent.Implement,
      name: "Follow the issue",
      requirement: "Follow the issue",
      criterion: "The issue is followed",
      verifications: ["true"],
      bindings: [ENGINE, ISSUES],
      external_links: links,
    });
    const importBody = async (links: unknown[]) => ({
      format: ImportFormat.Json,
      mission_id: missionId,
      mission_version: await missionVersion(),
      reason: "plan",
      entries: [entry(links)],
    });
    let nodeId = "";

    await t.test(
      "LF.1 an imported node holds the link in its content and in its export",
      async () => {
        const body = await importBody([LINK]);
        const preview = completed(
          await mission["import.preview"](
            { params: { mission_id: missionId }, query: {}, body },
            write(),
          ),
        );
        assert.deepEqual(preview.violations, []);
        const applied = completed(
          await mission["import.apply"](
            {
              params: { mission_id: missionId },
              query: {},
              body: {
                ...body,
                preview_digest: preview.preview_digest,
                confirmed_retirements: [],
              },
            },
            write(),
          ),
        );
        const [assigned] = applied.assigned_ids;
        assert.ok(assigned && "node_id" in assigned);
        nodeId = assigned.node_id;
        const revision = completed(
          await mission["node.revision.get"]({
            params: { node_id: nodeId, revision: FIRST_REVISION },
            query: {},
            body: null,
          }),
        );
        assert.deepEqual(revision.content.external_links, [LINK]);
        assert.deepEqual(
          revision.content.bindings,
          [ENGINE, ISSUES].map((name) => firstBindings(name).id),
        );
        const exported = completed(
          await mission.export({
            params: { mission_id: missionId },
            query: { format: ImportFormat.Json },
            body: null,
          }),
        );
        assert.ok("entries" in exported);
        const exportedNode = exported.entries.find(
          (item) => item.filename === NODE_FILENAME,
        );
        assert.ok(exportedNode && "external_links" in exportedNode);
        assert.deepEqual(exportedNode.external_links, [LINK]);
      },
    );

    await t.test(
      "LF.2 an import with a link of another conversation answers content_invalid",
      async () => {
        const body = await importBody([
          { ...LINK, resource_identity: OTHER_RESOURCE },
        ]);
        const preview = completed(
          await mission["import.preview"](
            { params: { mission_id: missionId }, query: {}, body },
            write(),
          ),
        );
        const error = refused(
          await mission["import.apply"](
            {
              params: { mission_id: missionId },
              query: {},
              body: {
                ...body,
                preview_digest: preview.preview_digest,
                confirmed_retirements: [],
              },
            },
            write(),
          ),
          HttpStatus.BadRequest,
          MissionErrorCode.ContentInvalid,
        );
        assert.deepEqual(
          (error.details as { field: string }).field,
          EXTERNAL_LINKS_FIELD,
        );
      },
    );

    const poll = await session.write<{ id: string }>(
      ["intake", "inbound", "create"],
      {
        project_id: project.id,
        kind: InboundKind.Poll,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: "github",
        configuration: {
          resource_kind: ResourceKind.Conversation,
          resource: REPOSITORY,
        },
      },
    );
    const events = async () =>
      (
        await session.read<Page<Event>>([
          "intake",
          "event",
          "list",
          "--inbound",
          poll.id,
        ])
      ).items;
    const rowsOf = (number: number) =>
      fixture.store.database
        .prepare(
          "SELECT id, update_key, actor_id, reason, binding_id, done_at, snoozed_until FROM mission_link_update WHERE external_link = ? ORDER BY occurred_at, id",
        )
        .all(canonicalJSON({ ...LINK, number })) as unknown as Row[];
    const linkedKeys: string[] = [];
    let sequence = 0;
    const comment = (input: {
      issue: number;
      user: number;
      body: string;
      type?: string;
    }) => {
      sequence += 1;
      const id = FIRST_COMMENT_ID + sequence;
      const payload = listedComment({
        id,
        user: commentUser({
          id: input.user,
          login: `user-${input.user}`,
          type: input.type ?? USER_TYPE,
        }),
        body: input.body,
        created_at: new Date(BASE_TIME + sequence * COMMENT_STEP_MS)
          .toISOString()
          .replace(".000Z", "Z"),
        html_url: `https://github.com/${REPOSITORY}/issues/${input.issue}#issuecomment-${id}`,
        issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${input.issue}`,
      });
      return { key: `issue_comment:${id}`, payload };
    };
    type Comment = ReturnType<typeof comment>;
    const say = async (input: Parameters<typeof comment>[0]) => {
      const posted = comment(input);
      gitHub.addIssueComment(OWNER, REPO, posted.payload);
      const settled = await until(
        async () =>
          (await events()).find((item) => item.event_id === posted.key),
        (item) =>
          item !== undefined && item.state !== InboundEventState.Pending,
        t.signal,
      );
      assert.equal(settled?.state, InboundEventState.Succeeded);
      if (input.issue === LINKED_ISSUE) linkedKeys.push(posted.key);
      return posted;
    };
    const admit = async (posted: Comment) =>
      completed(
        await service["delivery.admit"](
          {
            params: {},
            query: {},
            body: {
              inbound_event_id: createIdentity("inbound_event"),
              project_id: project.id,
              platform: InboundPlatform.GitHub,
              resource: CONVERSATION_RESOURCE,
              event: Buffer.from(JSON.stringify(posted.payload)).toString(
                "base64",
              ),
              metadata: { event: LISTED_EVENT },
            },
          },
          { identity: intakeIdentity, idempotencyKey: createIdempotencyKey() },
        ),
      );
    const thread = async (number: number, state: InboxItemState) =>
      completed(
        await mission["inbox_item.list"]({
          params: {},
          query: { project_id: project.id, state },
          body: null,
        }),
      ).items.find(
        (item) =>
          "number" in item.external_link &&
          item.external_link.number === number,
      );
    const nodeState = async () =>
      completed(
        await mission["node.get"]({
          params: { node_id: nodeId },
          query: {},
          body: null,
        }),
      ).state;
    gitHub.issueComments(OWNER, REPO, []);

    await t.test(
      "LF.3 the conversation poll reads the issue comments for a linked node and an inbox",
      async () => {
        const demand = completed(
          await service["delivery.unresolved_request.count"](
            {
              params: {},
              query: {},
              body: {
                project_id: project.id,
                resource_identity: CONVERSATION_RESOURCE,
              },
            },
            {
              identity: intakeIdentity,
              idempotencyKey: createIdempotencyKey(),
            },
          ),
        );
        assert.deepEqual(demand, {
          count: NO_COUNT,
          link_count: SINGLE_ITEM,
          inbox: true,
        });
        await until(
          () =>
            gitHub.calls.filter(
              (call) =>
                COMMENTS_PATH.test(call.path) && call.if_none_match !== null,
            ),
          (calls) => calls.length > NO_ITEMS,
          t.signal,
        );
      },
    );

    let trustedComment: Comment;
    await t.test(
      "LF.4 a comment of user 9 on issue 117 admits one linked row with the pin and keeps the node state",
      async () => {
        const before = await nodeState();
        trustedComment = await say({
          issue: LINKED_ISSUE,
          user: TRUSTED_USER,
          body: SECRET_BODY,
        });
        assert.equal(
          (await events()).filter(
            (item) => item.event_id === trustedComment.key,
          ).length,
          SINGLE_ITEM,
        );
        const rows = rowsOf(LINKED_ISSUE);
        assert.deepEqual(
          rows.map((row) => [row.update_key, row.reason, row.binding_id]),
          [[trustedComment.key, InboxReason.Linked, firstBindings(ISSUES).id]],
        );
        assert.equal(await nodeState(), before);
      },
    );

    let otherComment: Comment;
    await t.test(
      "LF.5 comments of user 7 and of a bot on issue 117",
      async () => {
        const other = await say({
          issue: LINKED_ISSUE,
          user: OTHER_USER,
          body: OTHER_BODY,
        });
        otherComment = other;
        assert.deepEqual(
          rowsOf(LINKED_ISSUE).map((row) => row.actor_id),
          [TRUSTED_ACTOR, OTHER_ACTOR],
        );
        assert.equal(
          rowsOf(LINKED_ISSUE).filter((row) => row.update_key === other.key)
            .length,
          SINGLE_ITEM,
        );
        const item = await thread(LINKED_ISSUE, InboxItemState.Open);
        assert.equal(item?.trusted, false);
        const bot = await say({
          issue: LINKED_ISSUE,
          user: BOT_USER,
          body: "Automated notice",
          type: BOT_TYPE,
        });
        assert.deepEqual(await admit(bot), {
          disposition: Disposition.Refused,
          reason: AdmissionRefusal.ActorIgnored,
        });
        assert.equal(rowsOf(LINKED_ISSUE).length, PAIR);
      },
    );

    await t.test(
      "LF.6 a mention on issue 118 admits a mentioned row and issue 119 is unmatched",
      async () => {
        const mention = await say({
          issue: MENTION_ISSUE,
          user: OTHER_USER,
          body: `@${INBOX_HANDLE} can you look at this?`,
        });
        assert.deepEqual(
          rowsOf(MENTION_ISSUE).map((row) => [row.update_key, row.reason]),
          [[mention.key, InboxReason.Mentioned]],
        );
        const plain = await say({
          issue: UNMATCHED_ISSUE,
          user: OTHER_USER,
          body: "Just chatting",
        });
        assert.deepEqual(await admit(plain), {
          disposition: Disposition.Refused,
          reason: AdmissionRefusal.Unmatched,
        });
        assert.equal(rowsOf(UNMATCHED_ISSUE).length, NO_ITEMS);
      },
    );

    await t.test(
      "LF.7 the inbox user closes the thread of issue 118 and a later comment reopens it",
      async () => {
        await say({
          issue: MENTION_ISSUE,
          user: INBOX_USER,
          body: "Looked at it.",
        });
        const closed = await thread(MENTION_ISSUE, InboxItemState.Done);
        assert.equal(closed?.state, InboxItemState.Done);
        await say({
          issue: MENTION_ISSUE,
          user: OTHER_USER,
          body: "One more thing.",
        });
        const reopened = await thread(MENTION_ISSUE, InboxItemState.Open);
        assert.equal(reopened?.state, InboxItemState.Open);
        assert.equal(reopened?.reason, InboxReason.Participating);
      },
    );

    await t.test(
      "LF.8 done of an older row answers open and a snooze of the newest row answers snoozed",
      async () => {
        const [older] = rowsOf(MENTION_ISSUE);
        const newest = rowsOf(MENTION_ISSUE).at(-SINGLE_ITEM);
        assert.ok(older && newest);
        const done = completed(
          await mission["inbox_item.done"](
            {
              params: { link_update_id: older.id },
              query: {},
              body: { snoozed_until: null },
            },
            write(),
          ),
        );
        assert.equal(done.state, InboxItemState.Open);
        assert.equal(done.link_update_id, newest.id);
        const snoozed = completed(
          await mission["inbox_item.done"](
            {
              params: { link_update_id: newest.id },
              query: {},
              body: { snoozed_until: Date.now() + MS_PER_DAY },
            },
            write(),
          ),
        );
        assert.equal(snoozed.state, InboxItemState.Snoozed);
      },
    );

    const connector = new RepositoryComponent();
    const transport: RepositoryTransport = {
      clone: async (_address, ...args) => {
        await connector.clone(engineBare.bare, ...args);
        await simpleGit(args[0]).addConfig("user.name", "Link Test");
        await simpleGit(args[0]).addConfig(
          "user.email",
          "link@example.invalid",
        );
      },
      cloneSnapshot: (_address, ...args) =>
        connector.cloneSnapshot(engineBare.bare, ...args),
      refreshSnapshot: (input) =>
        connector.refreshSnapshot({ ...input, address: engineBare.bare }),
      fetchAndCheckout: async (...args) => {
        await remapOrigin(args[0], () => engineBare.bare);
        return connector.fetchAndCheckout(...args);
      },
      fetchBase: (...args) => connector.fetchBase(...args),
      pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
    };
    const workspaces = WorkspaceRoot.open(temporary(t));
    const register = async (binding: string) => {
      const auth = await fixture.slotClient(project.id, binding);
      session.secrets.push(auth.token);
      const env = { ...session.H, KANTHORD_TOKEN: auth.token };
      const registration = await session.read<{ runtime_identity: string }>(
        ["worker", "register"],
        env,
      );
      return {
        ...auth,
        runtime_identity: registration.runtime_identity,
        env,
        binding,
        worker: httpClient(workerOperations, fixture.endpoint, auth.token),
      };
    };
    const coder = await register(GENERAL);
    const reviewer = await register(REVIEW);
    type Holder = typeof coder;
    const pull = async (holder: Holder, attempt: number, state: NodeState) => {
      const result = await session.write<{
        kind: string;
        execution: ExecutionRecord;
      }>(
        ["scheduler", "work", "pull"],
        {
          resource_identity: workerResourceIdentity(holder.binding),
          runtime_identity: holder.runtime_identity,
        },
        holder.env,
      );
      assert.equal(result.kind, WorkPullKind.Claimed);
      assert.equal(result.execution.node_id, nodeId);
      assert.equal(result.execution.attempt, attempt);
      assert.equal(await nodeState(), state);
      return result.execution;
    };
    const linkUpdates = async (holder: Holder, execution: ExecutionRecord) =>
      completed(
        await holder.worker["execution.link_update.get"]({
          params: { execution_id: execution.execution_id },
          query: {},
          body: null,
        }),
      );
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    const writing = (path: string) => [
      tool("write", { path, content: path }),
      fauxAssistantMessage(`wrote ${path}`),
      fauxAssistantMessage(`handled the updates of ${path}`),
    ];
    const execute = async (
      holder: Holder,
      execution: ExecutionRecord,
      script: Parameters<typeof scriptedProvider>[0],
    ) => {
      const envelope = completed(
        await holder.worker.handover({
          params: {},
          query: {},
          body: { execution_id: execution.execution_id },
        }),
      );
      const keys = deriveHandoverKeys(holder.client_secret);
      const aad = handoverAad(execution.execution_id, holder.runtime_identity);
      const payload = plainHandoverPayloadSchema.parse(
        openEnvelope(keys.handover, aad, envelope),
      );
      const credentials = executionCredentialStore(
        { items: payload.items },
        async (report) => {
          const reported = await holder.worker.credential({
            params: {},
            query: {},
            body: {
              execution_id: execution.execution_id,
              ...sealEnvelope(keys.report, aad, report),
            },
          });
          assert.equal(reported.type, OperationResultType.Completed);
        },
        async () => {
          throw new Error("Unexpected lease");
        },
      );
      const setup = completed(
        await holder.worker["execution.setup.get"]({
          params: { execution_id: execution.execution_id },
          query: {},
          body: null,
        }),
      );
      const provider = scriptedProvider(script);
      try {
        const result = await runNativeExecution({
          claim: execution,
          setup,
          clients: {
            mission: httpClient(
              missionOperations,
              fixture.endpoint,
              holder.token,
            ),
            scheduler: httpClient(
              schedulerOperations,
              fixture.endpoint,
              holder.token,
            ),
            worker: holder.worker,
          },
          credentials: {
            items: [
              {
                credential_id: payload.items[FIRST_ITEM]!.credential_id,
                provider_id: payload.items[FIRST_ITEM]!.provider_id,
                store: credentials.store,
              },
            ],
            release: () => credentials.release(),
          },
          transport,
          sshAccess: handedSshAccess(
            payload.ssh_identities,
            setup.repositories,
          ),
          workspaces,
          hostHome: temporary(t),
          env: hostEnvironment(),
          modelRuntimeFactory: scriptedModelRuntime(provider),
          hostTools: () => unusedHostTools,
          context: background,
        });
        return { result, prompt: JSON.stringify(provider.calls) };
      } finally {
        credentials.discard();
        keys.handover.fill(ZERO_BYTE);
        keys.report.fill(ZERO_BYTE);
      }
    };

    const act = async (state: NodeState, attempt: number) => ({
      reason: "hold",
      expected_mission_version: await missionVersion(),
      expected_state: state,
      expected_attempt: attempt,
    });
    await t.test(
      "LF.9 the first attempt reads the row of user 9 and, after a binding write and a rebind, the second attempt reads both rows",
      async () => {
        const first = await pull(coder, FIRST_ATTEMPT, NodeState.Executing);
        const read = await linkUpdates(coder, first);
        assert.deepEqual(
          read.items.map((item) => item.update_key),
          [trustedComment.key],
        );
        assert.equal(read.items[FIRST_ITEM]?.new, true);
        assert.equal(read.items[FIRST_ITEM]?.content?.author, TRUSTED_LOGIN);
        assert.equal(read.items[FIRST_ITEM]?.content?.body, REDACTED_BODY);
        const one = await execute(coder, first, writing("attempt-one.txt"));
        assert.deepEqual(one.result, RELEASED);
        assert.equal(await nodeState(), NodeState.Waiting);
        assert.ok(one.prompt.includes(`by ${TRUSTED_LOGIN}`));
        assert.ok(one.prompt.includes(REDACTED_BODY));
        assert.ok(!one.prompt.includes(OTHER_BODY));
        completed(
          await mission["node.pause"](
            {
              params: { node_id: nodeId },
              query: {},
              body: await act(NodeState.Waiting, FIRST_ATTEMPT),
            },
            write(),
          ),
        );
        completed(
          await mission["node.block"](
            {
              params: { node_id: nodeId },
              query: {},
              body: await act(NodeState.Paused, FIRST_ATTEMPT),
            },
            write(),
          ),
        );
        const applied = await session.write<{ binding_set_version: number }>(
          ["project", "binding", "apply", project.id],
          {
            version: firstApplied.binding_set_version,
            bindings: bindingSet([TRUSTED_ACTOR, OTHER_ACTOR]),
          },
        );
        assert.ok(
          applied.binding_set_version > firstApplied.binding_set_version,
        );
        const secondBindings = await bindingsOf();
        completed(
          await mission["node.rebind"](
            {
              params: { mission_id: missionId },
              query: {},
              body: {
                binding_id: secondBindings(ISSUES).id,
                reason: "trust user 7",
                expected_mission_version: await missionVersion(),
                node_id: nodeId,
              },
            },
            write(),
          ),
        );
        completed(
          await mission["node.unblock"](
            {
              params: { node_id: nodeId },
              query: {},
              body: {
                blocked_attempt: FIRST_ATTEMPT,
                expected_revision: SECOND_REVISION,
                expected_mission_version: await missionVersion(),
              },
            },
            write(),
          ),
        );
        const second = await pull(coder, SECOND_ATTEMPT, NodeState.Executing);
        const both = await linkUpdates(coder, second);
        assert.deepEqual(
          both.items.map((item) => item.update_key),
          [otherComment.key, trustedComment.key],
        );
        const two = await execute(coder, second, writing("attempt-two.txt"));
        assert.deepEqual(two.result, RELEASED);
        assert.ok(two.prompt.includes(`by ${TRUSTED_LOGIN}`));
        assert.ok(two.prompt.includes(REDACTED_BODY));
        assert.ok(two.prompt.includes(OTHER_BODY));
      },
    );

    let pullRequest = NO_COUNT;
    await t.test(
      "LF.10 the action performer posts one reply on issue 117 and the listed reply is ignored",
      async () => {
        const context = (execution: ExecutionRecord) => ({
          execution_id: execution.execution_id,
          attempt: execution.attempt,
          node_revision: execution.pinned_revision,
        });
        const submit = (execution: ExecutionRecord, body: object) =>
          session.write<{ evidence: { id: string } }>(
            ["mission", "evidence", "submit", nodeId],
            { ...context(execution), ...body },
            reviewer.env,
          );
        const attemptEvidence = await session.read<Page<Evidence>>([
          "mission",
          "evidence",
          "list",
          nodeId,
          "--attempt",
          String(SECOND_ATTEMPT),
        ]);
        const work = attemptEvidence.items.find((item) =>
          item.assets.some((asset) => asset.kind === AssetKind.Repository),
        );
        const published = work?.assets[FIRST_ITEM]?.address;
        assert.ok(work && published?.kind === AssetKind.Repository);
        gitHub.branchHead(`kanthord/${nodeId}`, published.commit);
        const tested = repositorySnapshot(
          published.binding_id,
          published.commit,
        );
        const evaluation = await pull(
          reviewer,
          SECOND_ATTEMPT,
          NodeState.Evaluating,
        );
        const run = await submit(evaluation, {
          subject: "verification run",
          assets: [
            {
              kind: "produced",
              content: {
                media_type: "text/plain",
                encoding: "base64",
                data: "b2s=",
              },
            },
          ],
          verification: {
            tested_input: tested,
            results: [
              {
                command: "true",
                exit_code: NO_COUNT,
                signal: null,
                timed_out: false,
              },
            ],
          },
        });
        await session.write(
          ["mission", "assessment", "submit", nodeId],
          {
            ...context(evaluation),
            evidence_ids: [run.evidence.id, work.id],
            dependency_outcome_ids: [],
            result: AssessmentResult.Success,
            rationale: "verified",
            tested_input: tested,
          },
          reviewer.env,
        );
        const performed = completed(
          await reviewer.worker["action.request"](
            {
              params: { execution_id: evaluation.execution_id },
              query: {},
              body: null,
            },
            write(),
          ),
        );
        assert.deepEqual(
          performed.items.map((item) => item.kind),
          [ActionResultKind.Submitted, ActionResultKind.Submitted],
        );
        await session.write(
          ["scheduler", "execution", "release", evaluation.execution_id],
          { further_work: false },
          reviewer.env,
        );
        assert.equal(await nodeState(), NodeState.ExternalRequested);
        assert.equal(
          gitHub.calls.filter(
            (call) =>
              call.method === HttpMethod.Post && POSTED_PATH.test(call.path),
          ).length,
          SINGLE_ITEM,
        );
        pullRequest = gitHub.pulls[FIRST_ITEM]!.number;
        const replyAction = async () =>
          (
            await session.read<Page<ExternalAction>>([
              "mission",
              "external-action",
              "list",
              nodeId,
              "--attempt",
              String(SECOND_ATTEMPT),
            ])
          ).items.find(
            (item) => item.action.action === ConversationAction.Reply,
          );
        const reply = await until(
          replyAction,
          (item) => item?.resolution === Resolution.ExpectedEnd,
          t.signal,
        );
        assert.equal(reply?.action.expected_end_state, ExpectedEndState.Posted);
        assert.equal(reply?.requested, true);
        const evidence = await session.read<Page<Evidence>>([
          "mission",
          "evidence",
          "list",
          nodeId,
          "--attempt",
          String(SECOND_ATTEMPT),
        ]);
        const request = evidence.items.find(
          (item) => item.id === reply?.request_evidence_id,
        );
        assert.equal(request?.end_state, EndState.Expected);
        const address = request?.assets[FIRST_ITEM]?.address;
        assert.ok(address && "update_key" in address);
        assert.equal(address.kind, PlatformAddressKind.Comment);
        const replyKey = address.update_key;
        linkedKeys.push(replyKey);
        const outbound = await session.read<
          Page<{ request_key: string; state: string }>
        >([
          "intake",
          "outbound",
          "list",
          "--operation",
          OutboundOperation.GitHubIssueComment,
        ]);
        assert.deepEqual(
          outbound.items.map((item) => item.state),
          [OutboundRequestState.Succeeded],
        );
        await until(
          async () =>
            (await events()).find((item) => item.event_id === replyKey),
          (item) =>
            item !== undefined && item.state !== InboundEventState.Pending,
          t.signal,
        );
        const [, replyId] = replyKey.split(":");
        const listedReply = {
          key: replyKey,
          payload: listedComment({
            id: Number(replyId),
            user: commentUser({ id: INBOX_USER, login: INBOX_HANDLE }),
            body: "KanthorD",
            created_at: new Date(BASE_TIME).toISOString(),
            html_url: `https://github.com/${REPOSITORY}/issues/${LINKED_ISSUE}#issuecomment-${replyId}`,
            issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${LINKED_ISSUE}`,
          }),
        };
        assert.deepEqual(await admit(listedReply), {
          disposition: Disposition.Refused,
          reason: AdmissionRefusal.ActorIgnored,
        });
        assert.equal(
          rowsOf(LINKED_ISSUE).filter((row) => row.update_key === replyKey)
            .length,
          NO_COUNT,
        );
      },
    );

    const check = async (id: string) =>
      completed(
        await mission["node.check"](
          {
            params: { node_id: id },
            query: {},
            body: { expected_mission_version: await missionVersion() },
          },
          write(),
        ),
      );
    await t.test(
      "LF.13 a change request of a reviewer outside link_trust blocks no node",
      async () => {
        gitHub.review(pullRequest, {
          reviewer: OTHER_USER,
          state: ReviewState.ChangesRequested,
          body: "Rename the route.",
        });
        const checked = await check(nodeId);
        assert.deepEqual(
          checked.results.map((item) => item.resolution),
          [Resolution.Unresolved],
        );
        assert.equal(await nodeState(), NodeState.ExternalRequested);
      },
    );

    await t.test(
      "LF.11a the merged pull request completes the node",
      async () => {
        gitHub.merge(pullRequest, MERGE_COMMIT);
        await check(nodeId);
        assert.equal(await nodeState(), NodeState.Completed);
      },
    );

    let followupNodeId = "";
    await t.test(
      "LF.11 a comment of user 9 after the completion opens one follow-up proposal and its approval creates the follow-up node",
      async () => {
        const proposals = async () =>
          completed(
            await mission["followup.list"]({
              params: { project_id: project.id },
              query: {},
              body: null,
            }),
          ).items;
        assert.deepEqual(await proposals(), []);
        await say({
          issue: LINKED_ISSUE,
          user: TRUSTED_USER,
          body: "Please also cover the CLI.",
        });
        assert.deepEqual(
          (await proposals()).map((item) => item.node_id),
          [nodeId],
        );
        await say({
          issue: LINKED_ISSUE,
          user: TRUSTED_USER,
          body: "And the documentation.",
        });
        assert.equal((await proposals()).length, SINGLE_ITEM);
        const rowCount = rowsOf(LINKED_ISSUE).length;
        const decided = completed(
          await mission["followup.decide"](
            {
              params: { node_id: nodeId },
              query: {},
              body: {
                expected_mission_version: await missionVersion(),
                approve: true,
              },
            },
            write(),
          ),
        );
        assert.ok(decided.created_node_id);
        followupNodeId = decided.created_node_id;
        const revisionOf = async (id: string) =>
          completed(
            await mission["node.revision.get"]({
              params: { node_id: id, revision: FIRST_REVISION },
              query: {},
              body: null,
            }),
          );
        const origin = completed(
          await mission["node.revision.get"]({
            params: { node_id: nodeId, revision: SECOND_REVISION },
            query: {},
            body: null,
          }),
        );
        const created = await revisionOf(followupNodeId);
        assert.deepEqual(created.content.external_links, [LINK]);
        assert.deepEqual(created.content.bindings, origin.content.bindings);
        const edges = completed(
          await mission["edge.list"]({
            params: { mission_id: missionId },
            query: {},
            body: null,
          }),
        );
        assert.ok(
          edges.items.some(
            (edge) =>
              edge.dependent_id === followupNodeId &&
              edge.depends_on_id === nodeId,
          ),
        );
        const idsOf = async (id: string) =>
          completed(
            await mission["link_update.list"]({
              params: { node_id: id },
              query: {},
              body: null,
            }),
          ).items.map((item) => item.id);
        const followupIds = await idsOf(followupNodeId);
        assert.deepEqual(followupIds, await idsOf(nodeId));
        assert.deepEqual(
          [...followupIds].sort(),
          rowsOf(LINKED_ISSUE)
            .map((row) => row.id)
            .sort(),
        );
        assert.equal(rowsOf(LINKED_ISSUE).length, rowCount);
        assert.equal(
          (await thread(LINKED_ISSUE, InboxItemState.Done))?.state,
          InboxItemState.Done,
        );
      },
    );

    await t.test(
      "LF.12 Check now reads issue 117 and a node with no request and no link answers no_unresolved_request",
      async () => {
        const checked = await check(nodeId);
        assert.deepEqual(checked.link_updates, [
          {
            external_link: LINK,
            admitted: NO_COUNT,
            duplicate: linkedKeys.length,
            refused: NO_COUNT,
          },
        ]);
        const created = completed(
          await mission["node.create"](
            {
              params: { mission_id: missionId },
              query: {},
              body: {
                filename: PLAIN_FILENAME,
                content: {
                  name: "Plain",
                  requirement: "Plain",
                  criterion: "Plain",
                  verifications: ["true"],
                  bindings: [],
                  intent: Intent.Examine,
                },
                tasks: [],
                reason: "plan",
                expected_mission_version: await missionVersion(),
              },
            },
            write(),
          ),
        );
        refused(
          await mission["node.check"](
            {
              params: { node_id: created.revisions[FIRST_ITEM]!.node_id },
              query: {},
              body: { expected_mission_version: await missionVersion() },
            },
            write(),
          ),
          HttpStatus.Conflict,
          MissionErrorCode.NoUnresolvedRequest,
        );
      },
    );
  },
);
