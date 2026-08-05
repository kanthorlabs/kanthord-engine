import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";
import {
  providerKinds,
  providerProjection,
} from "../../domain/provider-payload.ts";

export const providerRegisterRequest = z.object({
  name: z.string().min(1),
  kind: z.enum(providerKinds),
  payload: z.unknown(),
});

export const providerView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(providerKinds),
  projection: providerProjection.nullable(),
  setDefaultAt: z.number().nullable(),
  updatedAt: z.number(),
});

export const providerRegisterResponse = providerView;
export const providerListResponse = z.object({
  providers: z.array(providerView),
});
export const providerShowResponse = providerView;

export const credential = operations([
  {
    operationId: "provider.register",
    method: "POST",
    path: [resource("provider")],
    introducedIn: "phase-1",
    status: "routed",
    request: providerRegisterRequest,
    response: providerRegisterResponse,
  },
  {
    operationId: "provider.list",
    method: "GET",
    path: [resource("provider")],
    introducedIn: "phase-1",
    status: "routed",
    response: providerListResponse,
  },
  {
    operationId: "provider.show",
    method: "GET",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-1",
    status: "routed",
    response: providerShowResponse,
  },
  {
    operationId: "provider.rename",
    method: "POST",
    path: [resource("provider"), parameter("provider"), action("rename")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "provider.remove",
    method: "DELETE",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "provider.setDefault",
    method: "PUT",
    path: [resource("provider"), parameter("provider"), sub("default")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
