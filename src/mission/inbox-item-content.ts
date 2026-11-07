import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IntakeErrorCode } from "../intake/contract.ts";
import {
  type InboxContent,
  inboxContentSchema,
  type InboxItem,
  type IntakeLinks,
} from "./contract.ts";
import type { InboxThread } from "./inbox-item.ts";

function isEventNotFound(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    error.status === HttpStatus.NotFound &&
    error.code === IntakeErrorCode.InboundEventNotFound
  );
}

async function contentOf(
  intakeLinks: IntakeLinks,
  context: Context,
  inboundEventId: string,
): Promise<InboxContent | null> {
  try {
    const described = await intakeLinks.describe(context, inboundEventId);
    if (Object.values(described).every((value) => value === null)) return null;
    return inboxContentSchema.parse(described);
  } catch (error) {
    if (isEventNotFound(error)) return null;
    throw error;
  }
}

export async function withContent(
  intakeLinks: IntakeLinks,
  context: Context,
  threads: InboxThread[],
): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const thread of threads)
    items.push({
      ...thread,
      content: await contentOf(intakeLinks, context, thread.inbound_event_id),
    });
  return items;
}
