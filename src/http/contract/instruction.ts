import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { operations } from "./operation.ts";

export const agentListItem = z.object({
  agent: z.string(),
  purpose: z.string(),
  capabilities: z.object({ tools: z.array(z.string()) }),
});

export const agentListResponse = z.object({
  agents: z.array(agentListItem),
});

export const instruction = operations([
  {
    operationId: "agent.list",
    method: "GET",
    path: [resource("agent")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    response: agentListResponse,
    errors: { ...baselineErrors },
    examples: {
      success: {
        agents: [
          {
            agent: "re@1",
            purpose: "Reviews a diff against acceptance criteria.",
            capabilities: {
              tools: ["read", "bash", "grep", "find", "ls"],
            },
          },
        ],
      },
      error: {
        error: {
          code: "service-unavailable",
          message: "the daemon is shutting down",
        },
      },
    },
  },
  {
    operationId: "template.list",
    method: "GET",
    path: [resource("template")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "template.show",
    method: "GET",
    path: [resource("template"), parameter("deferred")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "profile.instantiate",
    method: "POST",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "profile.export",
    method: "GET",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "profile.import",
    method: "PUT",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
  {
    operationId: "profile.verify",
    method: "POST",
    path: [
      resource("repository"),
      parameter("repository"),
      sub("profile"),
      action("verify"),
    ],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "instructions.resolve",
    method: "GET",
    path: [resource("instruction"), action("resolve")],
    introducedIn: "phase-2",
    status: "stubbed",
    allowedActors: ["human"],
  },
]);
