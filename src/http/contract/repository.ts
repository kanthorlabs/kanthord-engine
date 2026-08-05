import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const repositoryInspectRequest = z.object({
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
});

export const hostKeyView = z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
});

export const repositoryInspectResponse = z.object({
  defaultBranch: z.string().nullable(),
  branches: z.array(z.string()),
  credential: z.object({
    reachable: z.boolean(),
    refusal: z.string().nullable(),
  }),
  hostKey: hostKeyView.nullable(),
});

export const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") && !value.endsWith("/") && !value.endsWith(".lock"),
    {
      message: "not a legal branch name",
    },
  );

export const repositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const repositoryRegisterRequest = z.object({
  name: repositoryName,
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
  upstreamBranch: branchName,
  landingBranch: branchName,
  publishRef: z
    .string()
    .min(1)
    .regex(/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/),
  publishOnApproval: z.boolean().default(true),
  hostFingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
    .nullable()
    .default(null),
});

export const repositoryView = z.object({
  id: z.string(),
  name: z.string(),
  remoteUrl: z.string(),
  credential: z.object({ id: z.string(), name: z.string() }),
  upstreamBranch: z.string(),
  landingBranch: z.string(),
  landingRef: z.string(),
  trackingRef: z.string(),
  publishRef: z.string(),
  publishOnApproval: z.boolean(),
  state: z.enum(["ready", "needs-reconcile"]),
  landingOid: z.string().nullable(),
  trackingOid: z.string().nullable(),
  fetchedUpstreamOid: z.string().nullable(),
  divergedLandingOid: z.string().nullable(),
  divergedUpstreamOid: z.string().nullable(),
  updatedAt: z.number(),
});

export const repositoryRegisterResponse = repositoryView;

export const repositoryListResponse = z.object({
  repositories: z.array(repositoryView),
});
export const repositoryShowResponse = repositoryView;

export const repository = operations([
  {
    operationId: "repository.inspect",
    method: "POST",
    path: [resource("repository"), action("inspect")],
    introducedIn: "phase-1",
    status: "routed",
    request: repositoryInspectRequest,
    response: repositoryInspectResponse,
  },
  {
    operationId: "repository.register",
    method: "POST",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
    request: repositoryRegisterRequest,
    response: repositoryView,
  },
  {
    operationId: "repository.list",
    method: "GET",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
    response: repositoryListResponse,
  },
  {
    operationId: "repository.show",
    method: "GET",
    path: [resource("repository"), parameter("repository")],
    introducedIn: "phase-1",
    status: "routed",
    response: repositoryShowResponse,
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
