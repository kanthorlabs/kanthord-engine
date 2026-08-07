import { z } from "zod";

import { parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";

export const projectName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const projectCreateRequest = z.strictObject({ name: projectName });

export const projectView = z.strictObject({
  id: z.string(),
  name: z.string(),
  repositories: z.array(z.string()),
  updatedAt: z.number(),
});

export const projectCreateResponse = projectView;
export const projectShowResponse = projectView;
export const projectListResponse = z.strictObject({
  projects: z.array(projectView),
});
export const projectRepositoriesRequest = z.strictObject({
  repositories: z.array(z.string().min(1)),
});
export const projectRepositoriesResponse = projectView;

export const projectView_example = {
  id: `project_${U}`,
  name: "atlas",
  repositories: [`repo_${U}`],
  updatedAt: A,
};

export const projectCreateExamples: OperationExamples = {
  request: { name: "atlas" },
  success: { ...projectView_example, repositories: [] },
  error: {
    error: {
      code: "invalid-request",
      message: "a project named atlas already exists",
      details: { refusal: "name-taken" },
    },
  },
};

export const projectListExamples: OperationExamples = {
  success: { projects: [projectView_example] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const projectShowExamples: OperationExamples = {
  success: projectView_example,
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const projectRepositoriesExamples: OperationExamples = {
  request: { repositories: [`repo_${U}`] },
  success: projectView_example,
  error: {
    error: {
      code: "invalid-request",
      message: "the same repository appears twice",
      details: { refusal: "duplicate-repository" },
    },
  },
};

export const project = operations([
  {
    operationId: "project.create",
    method: "POST",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
    idempotency: "memory",
    replayable: [200],
    request: projectCreateRequest,
    response: projectCreateResponse,
    errors: { ...baselineErrors },
    examples: projectCreateExamples,
  },
  {
    operationId: "project.list",
    method: "GET",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
    response: projectListResponse,
    errors: { ...baselineErrors },
    examples: projectListExamples,
  },
  {
    operationId: "project.show",
    method: "GET",
    path: [resource("project"), parameter("project")],
    introducedIn: "phase-1",
    status: "routed",
    response: projectShowResponse,
    errors: { ...baselineErrors },
    examples: projectShowExamples,
  },
  {
    operationId: "project.repositories",
    method: "PUT",
    path: [resource("project"), parameter("project"), sub("repository")],
    introducedIn: "phase-1",
    status: "routed",
    request: projectRepositoriesRequest,
    response: projectRepositoriesResponse,
    errors: { ...baselineErrors },
    examples: projectRepositoriesExamples,
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
