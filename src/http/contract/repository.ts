import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const repository = operations([
  {
    operationId: "repository.inspect",
    method: "POST",
    path: [resource("repository"), action("inspect")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "repository.register",
    method: "POST",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "repository.list",
    method: "GET",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "repository.show",
    method: "GET",
    path: [resource("repository"), parameter("repository")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "repository.landingBranch",
    method: "POST",
    path: [
      resource("repository"),
      parameter("repository"),
      sub("landing-branch"),
    ],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "repository.reconcile",
    method: "POST",
    path: [
      resource("repository"),
      parameter("repository"),
      action("reconcile"),
    ],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
