import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  providerRemoveExamples,
  providerRemoveResponse,
  providerRenameExamples,
  providerRenameRequest,
  providerRenameResponse,
  providerSetDefaultExamples,
  providerSetDefaultResponse,
} from "./credential.ts";
import { buildErrorEnvelope } from "./errors.ts";
import { renderPath } from "./path.ts";
import { findOperation } from "./registry.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";

describe("src/http/contract/credential.test", () => {
  it("the three phase-2 provider routes become routed with unchanged shape", () => {
    const expected = [
      ["provider.rename", "POST", "/v1/provider/:id/rename"],
      ["provider.remove", "DELETE", "/v1/provider/:id"],
      ["provider.setDefault", "PUT", "/v1/provider/:id/default"],
    ] as const;
    for (const [operationId, method, path] of expected) {
      const entry = findOperation(operationId);
      assert.equal(entry?.status, "routed", operationId);
      assert.equal(entry?.method, method, operationId);
      assert.equal(entry?.introducedIn, "phase-2", operationId);
      assert.equal(renderPath(entry!.path), path, operationId);
    }
  });

  it("the rename examples carry the exact story values", () => {
    assert.deepEqual(providerRenameExamples.request, {
      name: "github-release",
    });
    assert.deepEqual(providerRenameExamples.success, {
      id: `provider_${U}`,
      name: "github-release",
      kind: "git",
      projection: {
        transport: "http-basic",
        forge: "github",
        username: "atlas",
      },
      setDefaultAt: null,
      updatedAt: A,
    });
    assert.deepEqual(providerRenameExamples.error, {
      error: {
        code: "invalid-request",
        message: "a provider named github-release is already registered",
        details: { refusal: "name-taken" },
      },
    });
  });

  it("the remove examples carry the exact story values", () => {
    assert.deepEqual(providerRemoveExamples.success, { id: `provider_${U}` });
    assert.deepEqual(providerRemoveExamples.error, {
      error: {
        code: "binding-in-use",
        message: `provider provider_${U} is still in use`,
        details: {
          blockers: [
            { kind: "default-chain" },
            { kind: "project-binding", projectId: `project_${U}` },
            { kind: "repository", repositoryId: `repository_${U}` },
            { kind: "attempt", attemptId: `attempt_${U}` },
          ],
        },
      },
    });
  });

  it("the setDefault examples carry the exact story values", () => {
    assert.deepEqual(providerSetDefaultExamples.success, {
      id: `provider_${U}`,
      name: "openai",
      kind: "llm",
      projection: {
        provider: "openai",
        defaultModel: "gpt-4o",
        baseUrl: null,
      },
      setDefaultAt: A,
      updatedAt: A,
    });
    assert.deepEqual(providerSetDefaultExamples.error, {
      error: {
        code: "invalid-request",
        message: `provider provider_${U} of kind git cannot join the default chain`,
        details: { refusal: "kind-not-chainable" },
      },
    });
  });

  it("every example parses against its own strict schema and envelope", () => {
    const operations = [
      [
        "provider.rename",
        providerRenameExamples,
        providerRenameRequest,
        providerRenameResponse,
      ],
      [
        "provider.remove",
        providerRemoveExamples,
        undefined,
        providerRemoveResponse,
      ],
      [
        "provider.setDefault",
        providerSetDefaultExamples,
        undefined,
        providerSetDefaultResponse,
      ],
    ] as const;
    for (const [operationId, examples, request, response] of operations) {
      const entry = findOperation(operationId);
      assert.doesNotThrow(
        () => response.parse(examples.success),
        `${operationId} success example fails its response`,
      );
      assert.doesNotThrow(
        () => buildErrorEnvelope(entry!.errors!).parse(examples.error),
        `${operationId} error example fails its envelope`,
      );
      if (request !== undefined) {
        assert.doesNotThrow(
          () => request.parse(examples.request),
          `${operationId} request example fails its request`,
        );
      }
    }
  });

  it("an empty rename name is rejected", () => {
    assert.equal(providerRenameRequest.safeParse({ name: "" }).success, false);
  });

  it("an extra rename request key is rejected", () => {
    assert.equal(
      providerRenameRequest.safeParse({ name: "github-release", kind: "llm" })
        .success,
      false,
    );
  });

  it("an extra success key is rejected on rename and setDefault", () => {
    for (const response of [
      providerRenameResponse,
      providerSetDefaultResponse,
    ]) {
      const parsed = response.parse({
        id: `provider_${U}`,
        name: "github-release",
        kind: "git",
        projection: null,
        setDefaultAt: null,
        updatedAt: A,
      });
      assert.deepEqual(Object.keys(parsed).sort(), [
        "id",
        "kind",
        "name",
        "projection",
        "setDefaultAt",
        "updatedAt",
      ]);
      assert.equal(
        response.safeParse({
          id: `provider_${U}`,
          name: "github-release",
          kind: "git",
          projection: null,
          setDefaultAt: null,
          updatedAt: A,
          credential: "secret",
        }).success,
        false,
      );
    }
  });

  it("the remove response parses the id only and rejects any added key", () => {
    const parsed = providerRemoveResponse.parse({ id: `provider_${U}` });
    assert.deepEqual(Object.keys(parsed), ["id"]);
    assert.equal(
      providerRemoveResponse.safeParse({
        id: `provider_${U}`,
        credential: "secret",
      }).success,
      false,
    );
  });
});
