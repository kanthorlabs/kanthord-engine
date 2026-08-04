import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const graph = operations([
  {
    operationId: "plan.validate",
    method: "POST",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("validate"),
    ],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "plan.import",
    method: "POST",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("import"),
    ],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "plan.export",
    method: "GET",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      action("export"),
    ],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "plan.revisions",
    method: "GET",
    path: [
      resource("project"),
      parameter("project"),
      sub("plan"),
      sub("revision"),
    ],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "node.list",
    method: "GET",
    path: [resource("node")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "node.show",
    method: "GET",
    path: [resource("node"), parameter("node")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "edge.list",
    method: "GET",
    path: [resource("project"), parameter("project"), sub("edge")],
    introducedIn: "phase-1",
    status: "routed",
  },
]);
