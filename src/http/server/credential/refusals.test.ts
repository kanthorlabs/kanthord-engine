import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHttpError } from "./refusals.ts";
import { HttpError } from "../../contract/errors.ts";
import { invalidRequestDetails } from "../../contract/error-details.ts";
import { findOperation } from "../../contract/registry.ts";
import { PayloadError } from "../../../domain/provider-payload.ts";
import { SetDefaultProviderError } from "../../../commands/provider/set-default-provider.ts";
import { RenameProviderError } from "../../../commands/provider/rename-provider.ts";
import { RemoveProviderError } from "../../../commands/provider/remove-provider.ts";
import type { ProviderRemovalBlocker } from "../../../commands/provider/remove-provider.ts";

const id = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const blockers: readonly ProviderRemovalBlocker[] = [
  { kind: "default-chain" },
  { kind: "project-binding", projectId: "project_p" },
  { kind: "repository", repositoryId: "repository_chain" },
  { kind: "attempt", attemptId: "attempt_chain" },
];

describe("src/http/server/credential/refusals.test", () => {
  it("a SetDefaultProviderError not-found maps to a 404 not-found HttpError with no details", () => {
    const error = toHttpError(
      new SetDefaultProviderError("not-found", `no provider ${id}`),
    );
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "not-found");
    assert.equal(error.status, 404);
    assert.equal(error.details, undefined);
  });

  it("a SetDefaultProviderError kind-not-chainable maps to a 400 invalid-request with the refusal", () => {
    const error = toHttpError(
      new SetDefaultProviderError(
        "kind-not-chainable",
        `provider ${id} of kind git cannot join the default chain`,
      ),
    );
    assert.equal(error.code, "invalid-request");
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, { refusal: "kind-not-chainable" });
    assert.doesNotThrow(() => invalidRequestDetails.parse(error.details));
  });

  it("a RenameProviderError not-found maps to a 404 not-found HttpError with no details", () => {
    const error = toHttpError(
      new RenameProviderError("not-found", `no provider ${id}`),
    );
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "not-found");
    assert.equal(error.status, 404);
    assert.equal(error.details, undefined);
  });

  it("a RenameProviderError name-taken maps to a 400 invalid-request with the refusal", () => {
    const error = toHttpError(
      new RenameProviderError(
        "name-taken",
        "a provider named github-bot is already registered",
      ),
    );
    assert.equal(error.code, "invalid-request");
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, { refusal: "name-taken" });
    assert.doesNotThrow(() => invalidRequestDetails.parse(error.details));
  });

  it("a RemoveProviderError not-found maps to a 404 not-found HttpError with no details", () => {
    const error = toHttpError(
      new RemoveProviderError("not-found", `no provider ${id}`),
    );
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "not-found");
    assert.equal(error.status, 404);
    assert.equal(error.details, undefined);
  });

  it("a RemoveProviderError binding-in-use maps to a 409 binding-in-use with the blockers", () => {
    const error = toHttpError(
      new RemoveProviderError(
        "binding-in-use",
        `provider ${id} is still in use`,
        blockers,
      ),
    );
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, "binding-in-use");
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { blockers });
    const declared =
      findOperation("provider.remove")?.errors?.["binding-in-use"];
    assert.ok(
      declared !== undefined && declared !== null,
      "provider.remove declares binding-in-use",
    );
    assert.doesNotThrow(() => declared.parse(error.details));
  });

  it("a PayloadError still maps to a 400 invalid-request with refusal and detail", () => {
    const error = toHttpError(
      new PayloadError(
        "private-key-encrypted",
        "the private key is encrypted",
        "aes256-ctr",
      ),
    );
    assert.equal(error.code, "invalid-request");
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, {
      refusal: "private-key-encrypted",
      detail: "aes256-ctr",
    });
  });

  it("an unknown error is rethrown unchanged", () => {
    const boom = new Error("boom");
    assert.throws(
      () => toHttpError(boom),
      (caught) => caught === boom,
    );
  });
});
