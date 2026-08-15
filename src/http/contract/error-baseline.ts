import { invalidRequestDetails } from "./error-details.ts";
import type { OperationErrors } from "./operation.ts";

export const baselineErrors: OperationErrors = {
  "invalid-request": invalidRequestDetails.optional(),
  unauthenticated: null,
  "origin-forbidden": null,
  "host-forbidden": null,
  "actor-forbidden": null,
  "not-found": null,
  "not-implemented": null,
  "internal-error": null,
  "service-unavailable": null,
};
