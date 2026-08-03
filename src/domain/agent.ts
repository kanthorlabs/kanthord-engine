import { z } from "zod";

export const agentKinds = ["general@1", "swe@1", "te@1", "re@1"] as const;

export const agentKind = z.enum(agentKinds);

export type AgentKind = z.infer<typeof agentKind>;
