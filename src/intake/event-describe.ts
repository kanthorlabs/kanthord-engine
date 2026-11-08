import assert from "node:assert/strict";
import { isServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { describeGitHubEvent } from "../repository/github.ts";
import { MISSION_SERVICE_NAME } from "../mission/contract.ts";
import { WORKER_SERVICE_NAME } from "../worker/contract.ts";
import {
  type DescribedEvent,
  InboundPlatform,
  type InboundPlatformValue,
  IntakeErrorCode,
} from "./contract.ts";
import { configurationSchemaOf } from "./configuration.ts";
import { readEvent } from "./event-store.ts";
import { redactedText } from "./event-text.ts";
import { readInbound } from "./inbound-store.ts";
import { describeJiraEvent } from "./jira.ts";
import { describeSlackEvent } from "./slack.ts";

interface StoredEvent {
  event: Uint8Array;
  metadata: unknown;
  platform: InboundPlatformValue;
  resource: string;
}

type Describer = (input: StoredEvent) => {
  author: string;
  body: string;
  url: string;
  occurred_at: number;
} | null;

const DESCRIBERS: Readonly<Record<InboundPlatformValue, Describer>> = {
  [InboundPlatform.GitHub]: describeGitHubEvent,
  [InboundPlatform.Jira]: describeJiraEvent,
  [InboundPlatform.Slack]: describeSlackEvent,
};

const NO_DESCRIPTION: DescribedEvent = {
  author: null,
  body: null,
  url: null,
  occurred_at: null,
};

function notFound(): never {
  throw new OperationError(
    HttpStatus.NotFound,
    IntakeErrorCode.InboundEventNotFound,
    "Inbound event not found.",
  );
}

function readStored(tx: Transaction, id: string): StoredEvent {
  const row = readEvent(tx, id);
  if (row === null) notFound();
  const inbound = readInbound(tx, row.inbound_id);
  if (inbound === null) notFound();
  return {
    event: row.event,
    metadata: JSON.parse(row.metadata),
    platform: inbound.platform,
    resource: configurationSchemaOf(inbound.kind, inbound.platform).parse(
      JSON.parse(inbound.configuration),
    ).resource,
  };
}

export async function describeEvent(
  store: Store,
  caller: CallerContext,
  inboundEventId: string,
): Promise<DescribedEvent> {
  const identity = caller.identity;
  assert.ok(
    identity &&
      isServiceIdentity(identity) &&
      (identity.service === WORKER_SERVICE_NAME ||
        identity.service === MISSION_SERVICE_NAME),
    "The Worker Service or the Mission Service describes an event.",
  );
  const stored = store.transaction((tx) => readStored(tx, inboundEventId));
  const described = DESCRIBERS[stored.platform](stored);
  if (described === null) return NO_DESCRIPTION;
  return { ...described, body: redactedText(described.body) };
}
