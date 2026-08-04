import { resource } from "./path.ts";
import { operations } from "./operation.ts";

export const event = operations([
  {
    operationId: "event.list",
    method: "GET",
    path: [resource("event")],
    introducedIn: "phase-1",
    status: "routed",
  },
]);
