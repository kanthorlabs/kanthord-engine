import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const execution = operations([
  {
    operationId: "run.start",
    method: "POST",
    path: [resource("project"), parameter("project"), sub("run")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "run.cancel",
    method: "POST",
    path: [resource("run"), parameter("run"), action("cancel")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "run.list",
    method: "GET",
    path: [resource("run")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "run.show",
    method: "GET",
    path: [resource("run"), parameter("run")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "node.attempts",
    method: "GET",
    path: [resource("node"), parameter("node"), sub("attempt")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "attempt.show",
    method: "GET",
    path: [resource("attempt"), parameter("attempt")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "node.checks",
    method: "GET",
    path: [resource("node"), parameter("node"), sub("check")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "worker.list",
    method: "GET",
    path: [resource("worker")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
