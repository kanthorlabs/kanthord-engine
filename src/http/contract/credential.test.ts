import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  providerRegisterExamples,
  providerRegisterRequest,
  providerRemoveExamples,
  providerRemoveResponse,
  providerRenameExamples,
  providerRenameRequest,
  providerRenameResponse,
  providerSetDefaultExamples,
  providerSetDefaultResponse,
  providerView,
} from "./credential.ts";
import { buildErrorEnvelope } from "./errors.ts";
import { renderPath } from "./path.ts";
import { findOperation } from "./registry.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_ULID as U,
  EXAMPLE_ULID_B as UB,
} from "./example-literal.ts";

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
      displaced: [{ id: `provider_${UB}`, name: "anthropic" }],
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
    const view = {
      id: `provider_${U}`,
      name: "github-release",
      kind: "git",
      projection: null,
      setDefaultAt: null,
      updatedAt: A,
    };
    for (const [response, keys] of [
      [providerRenameResponse, Object.keys(view).sort()],
      [providerSetDefaultResponse, ["displaced", ...Object.keys(view)].sort()],
    ] as const) {
      const body =
        response === providerRenameResponse ? view : { ...view, displaced: [] };
      const parsed = response.parse(body);
      assert.deepEqual(Object.keys(parsed).sort(), keys);
      assert.equal(
        response.safeParse({ ...body, credential: "secret" }).success,
        false,
      );
    }
  });

  it("the setDefault response requires displaced and rejects a missing one", () => {
    const view = {
      id: `provider_${U}`,
      name: "openai",
      kind: "llm",
      projection: { provider: "openai", defaultModel: "gpt-4o", baseUrl: null },
      setDefaultAt: A,
      updatedAt: A,
    };
    assert.equal(providerSetDefaultResponse.safeParse(view).success, false);
    assert.deepEqual(
      providerSetDefaultResponse.parse({ ...view, displaced: [] }).displaced,
      [],
    );
    assert.equal(
      providerSetDefaultResponse.safeParse({
        ...view,
        displaced: [{ id: `provider_${UB}`, name: "anthropic", kind: "llm" }],
      }).success,
      false,
    );
    assert.equal(
      providerView.safeParse({ ...view, displaced: [] }).success,
      false,
    );
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

  it("providerRegisterRequest refuses git payload with password and accepts token", () => {
    const withPassword = {
      name: "github",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "atlas",
        password: "x",
      },
    };
    const withToken = {
      name: "github",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "atlas",
        token: "x",
      },
    };
    assert.equal(
      providerRegisterRequest.safeParse(withPassword).success,
      false,
    );
    assert.equal(providerRegisterRequest.safeParse(withToken).success, true);
  });

  it("providerRegisterRequest refuses llm payload with extra key and reports path", () => {
    const llmPayload = {
      name: "openai",
      kind: "llm",
      payload: {
        provider: "openai",
        apiKey: "sk-x",
        defaultModel: "gpt-4o",
        baseUrl: null,
        extraKey: "should-fail",
      },
    };
    const result = providerRegisterRequest.safeParse(llmPayload);
    assert.equal(result.success, false);
    const firstIssue = result.error.issues[0];
    assert.ok(firstIssue !== undefined);
    assert.equal(firstIssue.code, "unrecognized_keys");
    assert.deepEqual(firstIssue.path, ["payload"]);
    assert.deepEqual(firstIssue.keys, ["extraKey"]);
  });

  it("providerRegisterRequest refuses cross-product payload kinds", () => {
    const llmWithGitPayload = {
      name: "openai",
      kind: "llm",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "atlas",
        token: "x",
      },
    };
    const gitWithLlmPayload = {
      name: "github",
      kind: "git",
      payload: {
        provider: "openai",
        apiKey: "sk-x",
        defaultModel: "gpt-4o",
        baseUrl: null,
      },
    };
    assert.equal(
      providerRegisterRequest.safeParse(llmWithGitPayload).success,
      false,
    );
    assert.equal(
      providerRegisterRequest.safeParse(gitWithLlmPayload).success,
      false,
    );
  });

  it("providerRegisterRequest emits correct JSON Schema with two branches and nested git transports", () => {
    const schema = z.toJSONSchema(providerRegisterRequest, {
      target: "openapi-3.0",
      io: "input",
    }) as Record<string, unknown>;

    const oneOf = schema.oneOf as readonly Record<string, unknown>[];
    assert.ok(Array.isArray(oneOf), "root schema has oneOf");
    assert.equal(oneOf.length, 2, "exactly two branches for llm and git");

    const llmBranch = oneOf[0];
    assert.deepEqual(llmBranch.properties?.kind, {
      enum: ["llm"],
      type: "string",
    });
    assert.ok(
      !llmBranch.properties?.payload?.oneOf,
      "llm payload is not a union",
    );
    assert.equal(
      llmBranch.properties?.payload?.additionalProperties,
      false,
      "llm payload has additionalProperties: false",
    );

    const gitBranch = oneOf[1];
    assert.deepEqual(gitBranch.properties?.kind, {
      enum: ["git"],
      type: "string",
    });
    const gitPayloadOneOf = gitBranch.properties?.payload
      ?.oneOf as readonly Record<string, unknown>[];
    assert.ok(
      Array.isArray(gitPayloadOneOf),
      "git payload has oneOf for transports",
    );
    assert.equal(gitPayloadOneOf.length, 2, "exactly two transport branches");
    const transports = gitPayloadOneOf
      .map((b) => b.properties?.transport?.enum?.[0])
      .sort();
    assert.deepEqual(transports, ["http-basic", "ssh"]);

    function checkAdditionalPropertiesFalse(
      node: unknown,
      path = "root",
    ): void {
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.type === "object" && obj.properties) {
          assert.equal(
            obj.additionalProperties,
            false,
            `${path} missing additionalProperties: false`,
          );
        }
        for (const [key, value] of Object.entries(obj)) {
          if (
            key !== "enum" &&
            key !== "const" &&
            key !== "type" &&
            key !== "format"
          ) {
            checkAdditionalPropertiesFalse(value, `${path}.${key}`);
          }
          if (Array.isArray(value)) {
            value.forEach((v, i) =>
              checkAdditionalPropertiesFalse(v, `${path}.${key}[${i}]`),
            );
          }
        }
      }
    }
    checkAdditionalPropertiesFalse(schema);
  });
});
