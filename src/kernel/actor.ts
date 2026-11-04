import { z } from "zod";

export const humanActorSchema = z.strictObject({
  kind: z.literal("human"),
  account: z.string(),
  name: z.string(),
});
export type HumanActor = z.infer<typeof humanActorSchema>;
