import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  credentialRejectedDetails,
  hostKeyMismatchDetails,
} from "./error-details.ts";
import {
  EXAMPLE_FINGERPRINT as F,
  EXAMPLE_LANDING_OID as OID_L,
  EXAMPLE_TRACKING_OID as OID_T,
  EXAMPLE_UPSTREAM_OID as OID_U,
  EXAMPLE_AT as A,
  EXAMPLE_ULID as U,
} from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { repositoryStates } from "../../domain/repository.ts";

export const repositoryInspectRequest = z.strictObject({
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
});

export const hostKeyView = z.strictObject({
  algorithm: z.string(),
  fingerprint: z.string(),
});

export const repositoryInspectResponse = z.strictObject({
  defaultBranch: z.string().nullable(),
  branches: z.array(z.string()),
  credential: z.strictObject({
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

export const repositoryRegisterRequest = z.strictObject({
  name: repositoryName,
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
  branch: branchName,
  publishOnApproval: z.boolean().default(true),
  hostFingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
    .nullable()
    .default(null),
});

export const repositoryView = z.strictObject({
  id: z.string(),
  name: z.string(),
  remoteUrl: z.string(),
  credential: z.strictObject({ id: z.string(), name: z.string() }),
  branch: z.string(),
  landingRef: z.string(),
  trackingRef: z.string(),
  publishRef: z.string(),
  publishOnApproval: z.boolean(),
  state: z.enum(repositoryStates),
  landingOid: z.string().nullable(),
  trackingOid: z.string().nullable(),
  fetchedUpstreamOid: z.string().nullable(),
  divergedLandingOid: z.string().nullable(),
  divergedUpstreamOid: z.string().nullable(),
  updatedAt: z.number(),
});

export const repositoryRegisterResponse = repositoryView;

export const repositoryListResponse = z.strictObject({
  repositories: z.array(repositoryView),
});
export const repositoryShowResponse = repositoryView;

export const repositoryInspectExamples: OperationExamples = {
  request: {
    remoteUrl: "https://example.test/atlas.git",
    credentialId: `provider_${U}`,
  },
  success: {
    defaultBranch: "main",
    branches: ["main"],
    credential: { reachable: true, refusal: null },
    hostKey: null,
  },
  error: {
    error: {
      code: "credential-rejected",
      message: "the forge refused the credential",
      details: { failure: "auth-failed" },
    },
  },
};

export const repositoryView_example = {
  id: `repo_${U}`,
  name: "atlas",
  remoteUrl: "https://example.test/atlas.git",
  credential: { id: `provider_${U}`, name: "github" },
  branch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: OID_L,
  trackingOid: OID_T,
  fetchedUpstreamOid: OID_U,
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: A,
};

export const repositoryRegisterExamples: OperationExamples = {
  request: {
    name: "atlas",
    remoteUrl: "https://example.test/atlas.git",
    credentialId: `provider_${U}`,
    branch: "main",
    publishOnApproval: true,
    hostFingerprint: null,
  },
  success: repositoryView_example,
  error: {
    error: {
      code: "host-key-mismatch",
      message: `the host presented no key matching ${F}`,
      details: { presented: [F], confirmed: F },
    },
  },
};

export const repositoryListExamples: OperationExamples = {
  success: { repositories: [repositoryView_example] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const repositoryShowExamples: OperationExamples = {
  success: repositoryView_example,
  error: { error: { code: "not-found", message: `no repository repo_${U}` } },
};

export const repository = operations([
  {
    operationId: "repository.inspect",
    method: "POST",
    path: [resource("repository"), action("inspect")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: repositoryInspectRequest,
    response: repositoryInspectResponse,
    errors: {
      ...baselineErrors,
      "credential-rejected": credentialRejectedDetails,
      "host-key-mismatch": hostKeyMismatchDetails,
    },
    examples: repositoryInspectExamples,
  },
  {
    operationId: "repository.register",
    method: "POST",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: repositoryRegisterRequest,
    response: repositoryView,
    errors: {
      ...baselineErrors,
      "credential-rejected": credentialRejectedDetails,
      "host-key-mismatch": hostKeyMismatchDetails,
    },
    examples: repositoryRegisterExamples,
  },
  {
    operationId: "repository.list",
    method: "GET",
    path: [resource("repository")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: repositoryListResponse,
    errors: { ...baselineErrors },
    examples: repositoryListExamples,
  },
  {
    operationId: "repository.show",
    method: "GET",
    path: [resource("repository"), parameter("repository")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: repositoryShowResponse,
    errors: { ...baselineErrors },
    examples: repositoryShowExamples,
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
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
  },
]);
