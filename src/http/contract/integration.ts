import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const integration = operations([
  {
    operationId: "node.approvalEvidence",
    method: "GET",
    path: [resource("node"), parameter("node"), sub("approval")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "node.approve",
    method: "POST",
    path: [resource("node"), parameter("node"), action("approve")],
    introducedIn: "phase-2",
    status: "stubbed",
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "repository.publish",
    method: "POST",
    path: [resource("repository"), parameter("repository"), action("publish")],
    introducedIn: "phase-2",
    status: "stubbed",
    idempotency: "memory",
    replayable: [200],
  },
  {
    operationId: "gitOperation.list",
    method: "GET",
    path: [resource("git-operation")],
    introducedIn: "phase-3",
    status: "stubbed",
  },
]);
