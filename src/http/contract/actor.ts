import { z } from "zod";

import { action, parameter, resource } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import {
  actorNamePattern,
  bootstrapActorId,
  registeredActorKinds,
} from "../../domain/actor.ts";
import { identity } from "../../domain/identity.ts";

export const actorRegisterRequest = z.strictObject({
  name: z.string().regex(actorNamePattern),
});

export const actorView = z.strictObject({
  id: identity("actor"),
  kind: z.enum(registeredActorKinds),
  name: z.string(),
  registeredBy: identity("actor").nullable(),
  createdAt: z.int(),
  revokedAt: z.int().nullable(),
  revokedBy: identity("actor").nullable(),
});

export const actorTokenPattern =
  /^actor_[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43}$/;

export const actorRegisterResponse = actorView.extend({
  token: z.string().regex(actorTokenPattern),
});
export const actorRotateResponse = actorRegisterResponse;
export const actorShowResponse = actorView;
export const actorListResponse = z.strictObject({
  actors: z.array(actorView),
});

const exampleSecret = "abc-def_ghijklmnopqrstuvwxyzABCDEFGHIJKLMNO";
const exampleToken = `actor_${U}.${exampleSecret}`;

const exampleView = {
  id: `actor_${U}`,
  kind: "harness",
  name: "worker-a",
  registeredBy: bootstrapActorId,
  createdAt: A,
  revokedAt: null,
  revokedBy: null,
};

export const actorRegisterExamples: OperationExamples = {
  request: { name: "worker-a" },
  success: { ...exampleView, token: exampleToken },
  error: {
    error: {
      code: "invalid-request",
      message: "a harness named worker-a is already registered",
      details: { refusal: "name-taken" },
    },
  },
};

export const actorListExamples: OperationExamples = {
  success: { actors: [exampleView] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const actorShowExamples: OperationExamples = {
  success: exampleView,
  error: { error: { code: "not-found", message: `no actor actor_${U}` } },
};

export const actorRevokeExamples: OperationExamples = {
  success: exampleView,
  error: {
    error: {
      code: "invalid-request",
      message: "the bootstrap actor cannot be revoked",
      details: { refusal: "bootstrap-actor" },
    },
  },
};

export const actorRotateExamples: OperationExamples = {
  success: { ...exampleView, token: exampleToken },
  error: {
    error: {
      code: "invalid-request",
      message: "the bootstrap actor cannot rotate its token",
      details: { refusal: "bootstrap-actor" },
    },
  },
};

export const actor = operations([
  {
    operationId: "actor.register",
    method: "POST",
    path: [resource("actor")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    successStatus: 200,
    request: actorRegisterRequest,
    response: actorRegisterResponse,
    errors: { ...baselineErrors },
    examples: actorRegisterExamples,
  },
  {
    operationId: "actor.list",
    method: "GET",
    path: [resource("actor")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: actorListResponse,
    errors: { ...baselineErrors },
    examples: actorListExamples,
  },
  {
    operationId: "actor.show",
    method: "GET",
    path: [resource("actor"), parameter("actor")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: actorShowResponse,
    errors: { ...baselineErrors },
    examples: actorShowExamples,
  },
  {
    operationId: "actor.revoke",
    method: "POST",
    path: [resource("actor"), parameter("actor"), action("revoke")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    successStatus: 200,
    response: actorShowResponse,
    errors: { ...baselineErrors },
    examples: actorRevokeExamples,
  },
  {
    operationId: "actor.rotate",
    method: "POST",
    path: [resource("actor"), parameter("actor"), action("rotate")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    successStatus: 200,
    response: actorRotateResponse,
    errors: { ...baselineErrors },
    examples: actorRotateExamples,
  },
]);
