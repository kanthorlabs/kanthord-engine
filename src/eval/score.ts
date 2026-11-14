import { z } from "zod";
import { CodedError } from "../kernel/errors.ts";
import { isObject } from "../kernel/values.ts";
import {
  type SessionEntry,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "../workbench/contract.ts";
import { recordOf, toolName } from "../workbench/index.ts";

const NEWLINE = "\n";
const BlockType = { Text: "text", ToolCall: "toolCall" } as const;
const Role = { Assistant: "assistant", ToolResult: "toolResult" } as const;
const NO_FAILURES = 0;
const MINIMUM_MATCHES = 1;
const PASSED_DETAIL = "";
const FAILURE_SEPARATOR = "; ";

export interface ObservedCall {
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ObservedResult {
  is_error: boolean;
  text: string;
}

export type ObservedOffer = Extract<
  WorkbenchRecord,
  { kind: typeof WorkbenchRecordKind.ActionOffer }
>;

export interface SessionObservation {
  calls: ObservedCall[];
  results: Record<string, ObservedResult>;
  reply: string;
  offers: ObservedOffer[];
  usage: { input: number; output: number; cost: number };
}

export interface Confirmation {
  operation_id: string;
  tool_call_id: string;
  answer: string;
}

export interface Observation extends SessionObservation {
  confirmations: Confirmation[];
  unexpected_approval: boolean;
}

const blockSchema = z.looseObject({ type: z.string() });
const textBlockSchema = z.looseObject({
  type: z.literal(BlockType.Text),
  text: z.string(),
});
const toolCallBlockSchema = z.looseObject({
  type: z.literal(BlockType.ToolCall),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const messageEnvelopeSchema = z.looseObject({
  type: z.literal("message"),
  message: z.looseObject({ role: z.string() }),
});
const assistantMessageSchema = z.looseObject({
  role: z.literal(Role.Assistant),
  content: z.array(blockSchema),
  usage: z.looseObject({
    input: z.number(),
    output: z.number(),
    cost: z.looseObject({ total: z.number() }),
  }),
});
const toolResultMessageSchema = z.looseObject({
  role: z.literal(Role.ToolResult),
  toolCallId: z.string(),
  content: z.array(blockSchema),
  isError: z.boolean(),
});

function textsOf(blocks: readonly z.infer<typeof blockSchema>[]): string[] {
  return blocks
    .filter((block) => block.type === BlockType.Text)
    .map((block) => textBlockSchema.parse(block).text);
}

function callsOf(blocks: readonly z.infer<typeof blockSchema>[]) {
  return blocks
    .filter((block) => block.type === BlockType.ToolCall)
    .map((block): ObservedCall => {
      const call = toolCallBlockSchema.parse(block);
      return {
        tool_call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      };
    });
}

export function observationOf(
  entries: readonly SessionEntry[],
): SessionObservation {
  const calls: ObservedCall[] = [];
  const results: Record<string, ObservedResult> = {};
  const replies: string[] = [];
  const usage = { input: 0, output: 0, cost: 0 };
  for (const entry of entries) {
    const envelope = messageEnvelopeSchema.safeParse(entry);
    if (!envelope.success) continue;
    const { message } = envelope.data;
    if (message.role === Role.Assistant) {
      const assistant = assistantMessageSchema.parse(message);
      calls.push(...callsOf(assistant.content));
      replies.push(...textsOf(assistant.content));
      usage.input += assistant.usage.input;
      usage.output += assistant.usage.output;
      usage.cost += assistant.usage.cost.total;
    }
    if (message.role === Role.ToolResult) {
      const result = toolResultMessageSchema.parse(message);
      results[result.toolCallId] = {
        is_error: result.isError,
        text: textsOf(result.content).join(NEWLINE),
      };
    }
  }
  const offers = entries.flatMap((entry) => {
    const record = recordOf(entry);
    return record?.kind === WorkbenchRecordKind.ActionOffer ? [record] : [];
  });
  return {
    calls,
    results,
    reply: replies.join(NEWLINE),
    offers,
    usage,
  };
}

const callExpectationSchema = z.union([
  z.strictObject({
    operation_id: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    count: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    count: z.int().nonnegative().optional(),
  }),
]);
export type CallExpectation = z.infer<typeof callExpectationSchema>;

function isPattern(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const countSchema = z.int().nonnegative();
const offerSchema = z.strictObject({
  operation_id: z.string(),
  target_id: z.string(),
});
const offerFilterSchema = z.strictObject({
  operation_id: z.string().optional(),
  target_id: z.string().optional(),
});

export const expectCallsSchema = z.array(callExpectationSchema);
export const forbidCallsSchema = z.array(callExpectationSchema);
export const finalStateSchema = z.array(
  z.strictObject({
    operation_id: z.string(),
    input: z.record(z.string(), z.unknown()),
    expect: z.json(),
  }),
);
export const replyContainsSchema = z.array(z.string());
export const replyForbidsSchema = z.array(
  z
    .string()
    .refine(isPattern, "The pattern is not a valid regular expression."),
);
export const maxToolCallsSchema = countSchema;
export const maxConfirmationsSchema = countSchema;
export const expectOfferSchema = offerSchema;
export const forbidOfferSchema = z.array(offerFilterSchema);
export const maxOffersSchema = countSchema;

export const checksSchema = z.strictObject({
  expect_calls: expectCallsSchema.optional(),
  forbid_calls: forbidCallsSchema.optional(),
  final_state: finalStateSchema.optional(),
  reply_contains: replyContainsSchema.optional(),
  reply_forbids: replyForbidsSchema.optional(),
  max_tool_calls: maxToolCallsSchema.optional(),
  max_confirmations: maxConfirmationsSchema.optional(),
  expect_offer: expectOfferSchema.optional(),
  forbid_offer: forbidOfferSchema.optional(),
  max_offers: maxOffersSchema.optional(),
});
export type Checks = z.infer<typeof checksSchema>;

export type ReadOperation = (
  operationId: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface CheckResult {
  kind: string;
  passed: boolean;
  detail: string;
}

export interface RunScore {
  passed: boolean;
  checks: CheckResult[];
}

export function holds(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => holds(item, actual[index]))
    );
  if (isObject(expected))
    return (
      isObject(actual) &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(actual, key) && holds(value, Reflect.get(actual, key)),
      )
    );
  return expected === actual;
}

function describe(value: unknown): string {
  return JSON.stringify(value);
}

function callMatches(item: CallExpectation, call: ObservedCall): boolean {
  const name = "tool" in item ? item.tool : toolName(item.operation_id);
  return (
    call.name === name &&
    (item.input === undefined || holds(item.input, call.arguments))
  );
}

function expectCalls(
  items: readonly CallExpectation[],
  calls: readonly ObservedCall[],
): string[] {
  return items.flatMap((item) => {
    const matched = calls.filter((call) => callMatches(item, call)).length;
    const passed =
      item.count === undefined
        ? matched >= MINIMUM_MATCHES
        : matched === item.count;
    return passed
      ? []
      : [`${describe(item)} matched ${matched} of ${calls.length} calls`];
  });
}

function forbidCalls(
  items: readonly CallExpectation[],
  calls: readonly ObservedCall[],
): string[] {
  return items.flatMap((item) =>
    calls
      .filter((call) => callMatches(item, call))
      .map((call) => `${describe(item)} matched call ${describe(call)}`),
  );
}

function failureCode(error: unknown): string {
  if (error instanceof CodedError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

async function finalState(
  items: z.infer<typeof finalStateSchema>,
  read: ReadOperation,
): Promise<string[]> {
  const failures: string[] = [];
  for (const item of items) {
    try {
      const answer = await read(item.operation_id, item.input);
      if (!holds(item.expect, answer))
        failures.push(`${item.operation_id} answered ${describe(answer)}`);
    } catch (error) {
      failures.push(`${item.operation_id} failed with ${failureCode(error)}`);
    }
  }
  return failures;
}

function replyContains(items: readonly string[], reply: string): string[] {
  const folded = reply.toLowerCase();
  return items
    .filter((item) => !folded.includes(item.toLowerCase()))
    .map((item) => `the reply lacks ${describe(item)}`);
}

function replyForbids(items: readonly string[], reply: string): string[] {
  return items
    .filter((item) => new RegExp(item).test(reply))
    .map((item) => `the reply matches ${describe(item)}`);
}

function atMost(label: string, limit: number, count: number): string[] {
  return count <= limit ? [] : [`${count} ${label}, at most ${limit}`];
}

function offerMatches(
  filter: z.infer<typeof offerFilterSchema>,
  offer: ObservedOffer,
): boolean {
  return (
    (filter.operation_id === undefined ||
      filter.operation_id === offer.operation_id) &&
    (filter.target_id === undefined || filter.target_id === offer.target_id)
  );
}

function expectOffer(
  expected: z.infer<typeof offerSchema>,
  offers: readonly ObservedOffer[],
): string[] {
  return offers.some((offer) => offerMatches(expected, offer))
    ? []
    : [`no offer matches ${describe(expected)}`];
}

function forbidOffer(
  filters: z.infer<typeof forbidOfferSchema>,
  offers: readonly ObservedOffer[],
): string[] {
  return filters.flatMap((filter) =>
    offers
      .filter((offer) => offerMatches(filter, offer))
      .map((offer) => `${describe(filter)} matched offer ${describe(offer)}`),
  );
}

function resultOf(kind: string, failures: readonly string[]): CheckResult {
  return {
    kind,
    passed: failures.length === NO_FAILURES,
    detail: failures.length ? failures.join(FAILURE_SEPARATOR) : PASSED_DETAIL,
  };
}

export async function scoreRun(
  checks: Checks,
  observation: Observation,
  read: ReadOperation,
): Promise<RunScore> {
  const results: CheckResult[] = [];
  const { calls, offers, reply } = observation;
  if (checks.expect_calls)
    results.push(
      resultOf("expect_calls", expectCalls(checks.expect_calls, calls)),
    );
  if (checks.forbid_calls)
    results.push(
      resultOf("forbid_calls", forbidCalls(checks.forbid_calls, calls)),
    );
  if (checks.final_state)
    results.push(
      resultOf("final_state", await finalState(checks.final_state, read)),
    );
  if (checks.reply_contains)
    results.push(
      resultOf("reply_contains", replyContains(checks.reply_contains, reply)),
    );
  if (checks.reply_forbids)
    results.push(
      resultOf("reply_forbids", replyForbids(checks.reply_forbids, reply)),
    );
  if (checks.max_tool_calls !== undefined)
    results.push(
      resultOf(
        "max_tool_calls",
        atMost("tool calls", checks.max_tool_calls, calls.length),
      ),
    );
  if (checks.max_confirmations !== undefined)
    results.push(
      resultOf(
        "max_confirmations",
        atMost(
          "confirmations",
          checks.max_confirmations,
          observation.confirmations.length,
        ),
      ),
    );
  if (checks.expect_offer)
    results.push(
      resultOf("expect_offer", expectOffer(checks.expect_offer, offers)),
    );
  if (checks.forbid_offer)
    results.push(
      resultOf("forbid_offer", forbidOffer(checks.forbid_offer, offers)),
    );
  if (checks.max_offers !== undefined)
    results.push(
      resultOf(
        "max_offers",
        atMost("offers", checks.max_offers, offers.length),
      ),
    );
  results.push(
    resultOf(
      "unexpected_approval",
      observation.unexpected_approval
        ? ["an unexpected approval appeared"]
        : [],
    ),
  );
  return { passed: results.every((result) => result.passed), checks: results };
}
