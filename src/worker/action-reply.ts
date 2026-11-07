import { replyRequestKey } from "../intake/contract.ts";
import {
  type ActionContext,
  ConversationAction,
  type PlatformAddress,
  PlatformAddressKind,
  type ReplyFrozenAction,
} from "./contract.ts";

const LINE_SEPARATOR = "\n";

export type ReplyEntry = Omit<ActionContext["actions"][number], "action"> & {
  action: ReplyFrozenAction;
};

export function isReplyEntry(
  entry: ActionContext["actions"][number],
): entry is ReplyEntry {
  return entry.action.action === ConversationAction.Reply;
}

export function replyKeyOf(
  nodeId: string,
  attempt: number,
  action: ReplyFrozenAction,
): string {
  return replyRequestKey(nodeId, attempt, action.configuration.external_link);
}

function addressLineOf(address: PlatformAddress): string {
  if (address.kind === PlatformAddressKind.PullRequest)
    return `${address.resource_identity} pull request #${address.number}`;
  if (address.kind === PlatformAddressKind.BranchPush)
    return `${address.resource_identity} branch ${address.branch} at ${address.commit}`;
  return `${address.resource_identity} comment ${address.update_key}`;
}

export function replyBodyOf(
  context: Pick<ActionContext, "node_name" | "request_addresses">,
  attempt: number,
): string {
  const header = `KanthorD: the review of node ${context.node_name} passed at attempt ${attempt}.`;
  return [header, ...context.request_addresses.map(addressLineOf)].join(
    LINE_SEPARATOR,
  );
}
