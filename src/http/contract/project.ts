import { z } from "zod";

import { parameter, resource, sub } from "./path.ts";
import { operations } from "./operation.ts";

export const projectName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const projectCreateRequest = z.object({ name: projectName });

export const projectView = z.object({
  id: z.string(),
  name: z.string(),
  repositories: z.array(z.string()),
  updatedAt: z.number(),
});

export const projectCreateResponse = projectView;
export const projectShowResponse = projectView;
export const projectListResponse = z.object({ projects: z.array(projectView) });
export const projectRepositoriesRequest = z.object({
  repositories: z.array(z.string().min(1)),
});
export const projectRepositoriesResponse = projectView;

export const project = operations([
  {
    operationId: "project.create",
    method: "POST",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
    request: projectCreateRequest,
    response: projectCreateResponse,
  },
  {
    operationId: "project.list",
    method: "GET",
    path: [resource("project")],
    introducedIn: "phase-1",
    status: "routed",
    response: projectListResponse,
  },
  {
    operationId: "project.show",
    method: "GET",
    path: [resource("project"), parameter("project")],
    introducedIn: "phase-1",
    status: "routed",
    response: projectShowResponse,
  },
  {
    operationId: "project.repositories",
    method: "PUT",
    path: [resource("project"), parameter("project"), sub("repository")],
    introducedIn: "phase-1",
    status: "routed",
    request: projectRepositoriesRequest,
    response: projectRepositoriesResponse,
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
