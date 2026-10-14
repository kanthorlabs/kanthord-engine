import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import { LogDestination } from "../../kernel/log.ts";
import { isObject } from "../../kernel/values.ts";

export const threadDataSchema = z.strictObject({
  port: z.custom<MessagePort>(
    (value) => isObject(value) && "postMessage" in value && "on" in value,
  ),
  client_secret: z.string().min(1),
  log: z.literal(LogDestination.File),
});
export type ThreadData = z.infer<typeof threadDataSchema>;

export const ThreadControl = { Drain: "drain", Stop: "stop" } as const;
export const threadControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal(ThreadControl.Drain) }),
  z.strictObject({ kind: z.literal(ThreadControl.Stop) }),
]);
export type ThreadControl = z.infer<typeof threadControlSchema>;
