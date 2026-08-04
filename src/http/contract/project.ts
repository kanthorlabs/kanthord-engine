import { parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const project = operations([
  {
    operationId: "project.create",
    method: "POST",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "project.list",
    method: "GET",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "project.show",
    method: "GET",
    path: [resource("project"), parameter("project")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "project.repositories",
    method: "PUT",
    path: [resource("project"), parameter("project"), sub("repository")],
    introducedIn: "phase-1",
    status: "routed",
  },
  {
    operationId: "binding.worker.project",
    method: "PUT",
    path: [
      resource("project"),
      parameter("project"),
      sub("binding"),
      sub("worker"),
    ],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
