import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import { LogDestination } from "../../kernel/log.ts";
import { isObject } from "../../kernel/values.ts";
import { BindingEntryState } from "../../worker/contract.ts";

const portSchema = z.custom<MessagePort>(
  (value) => isObject(value) && "postMessage" in value && "on" in value,
);

export const threadEntrySchema = z.strictObject({
  client_id: z.string().min(1),
  port: portSchema.nullable(),
  client_secret: z.string().min(1),
  state: z.enum(BindingEntryState),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export const threadDataSchema = z.strictObject({
  entries: z.array(threadEntrySchema),
  log: z.enum(LogDestination),
});
export type ThreadData = z.infer<typeof threadDataSchema>;

export const SlotControl = { Drain: "drain", Stop: "stop" } as const;
export const ThreadMessageKind = {
  ...SlotControl,
  Bindings: "bindings",
} as const;
export const slotControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal(SlotControl.Drain) }),
  z.strictObject({ kind: z.literal(SlotControl.Stop) }),
]);
export type SlotControl = z.infer<typeof slotControlSchema>;
export const threadMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal(ThreadMessageKind.Drain) }),
  z.strictObject({ kind: z.literal(ThreadMessageKind.Stop) }),
  z.strictObject({
    kind: z.literal(ThreadMessageKind.Bindings),
    entries: z.array(threadEntrySchema),
  }),
]);
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

export function entryPorts(entries: readonly ThreadEntry[]): MessagePort[] {
  return entries.flatMap(({ port }) => (port === null ? [] : [port]));
}
