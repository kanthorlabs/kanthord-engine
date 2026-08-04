import { action, parameter, resource } from "./path.ts";
import { operations } from "./operation.ts";

export const outcome = operations([
  {
    operationId: "node.unblock",
    method: "POST",
    path: [resource("node"), parameter("node"), action("unblock")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "node.abandon",
    method: "POST",
    path: [resource("node"), parameter("node"), action("abandon")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "node.discard",
    method: "POST",
    path: [resource("node"), parameter("node"), action("discard")],
    introducedIn: "phase-3",
    status: "stubbed",
  },
  {
    operationId: "node.waive",
    method: "POST",
    path: [resource("node"), parameter("node"), action("waive")],
    introducedIn: "phase-3",
    status: "stubbed",
  },
]);
