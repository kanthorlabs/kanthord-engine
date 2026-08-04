import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const instruction = operations([
  {
    operationId: "agent.list",
    method: "GET",
    path: [resource("agent")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "template.list",
    method: "GET",
    path: [resource("template")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "template.show",
    method: "GET",
    path: [resource("template"), parameter("deferred")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "profile.instantiate",
    method: "POST",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "profile.export",
    method: "GET",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "profile.import",
    method: "PUT",
    path: [resource("repository"), parameter("repository"), sub("profile")],
    introducedIn: "phase-2",
    status: "stubbed",
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
  },
  {
    operationId: "instructions.resolve",
    method: "GET",
    path: [resource("instruction"), action("resolve")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
