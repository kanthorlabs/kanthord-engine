import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { GitError } from "../../../services/git/index.ts";
import { InspectRepositoryError } from "../../../queries/repository/inspect-repository.ts";
import type {
  InspectRepositoryInput,
  InspectRepositoryResult,
} from "../../../queries/repository/inspect-repository.ts";
import { inspectRepositoryHandler } from "./inspect-repository.ts";
import { repositoryInspectResponse } from "../../contract/repository.ts";

const result: InspectRepositoryResult = {
  defaultBranch: "main",
  branches: ["main"],
  credential: { reachable: true, refusal: null },
  hostKey: null,
};

async function handlerApp(
  inspectRepository: (
    input: InspectRepositoryInput,
  ) => Promise<InspectRepositoryResult>,
) {
  return createTestApp({
    handlers: {
      "repository.inspect": inspectRepositoryHandler({ inspectRepository }),
    },
  });
}

describe("src/http/server/repository/inspect-repository.test", () => {
  it("POST /v1/repository/inspect with a valid body answers 200 and the response schema parses the body", async () => {
    let called: InspectRepositoryInput | undefined;
    const app = await handlerApp(async (input) => {
      called = input;
      return result;
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 200);
    assert.equal(
      repositoryInspectResponse.safeParse(response.body).success,
      true,
    );
    assert.deepEqual(called, {
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
  });

  it("a body missing credentialId answers 400 invalid-request", async () => {
    const app = await handlerApp(async () => result);
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a refused url answers 400 invalid-request with url-refused", async () => {
    const app = await handlerApp(async () => {
      throw new GitError("url-refused", "the scheme ftp is not allowed");
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "ftp://example.com/r.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "url-refused");
  });

  it("an unknown credential answers 404 not-found", async () => {
    const app = await handlerApp(async () => {
      throw new InspectRepositoryError(
        "credential-not-found",
        "no provider provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
      );
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("a wrong-kind credential answers 400 with credential-wrong-kind", async () => {
    const app = await handlerApp(async () => {
      throw new InspectRepositoryError(
        "credential-wrong-kind",
        "provider x is of kind llm; repository.inspect needs kind git",
      );
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "credential-wrong-kind");
  });

  it("an unreadable credential answers 400 with credential-unreadable", async () => {
    const app = await handlerApp(async () => {
      throw new InspectRepositoryError(
        "credential-unreadable",
        "the payload of provider x cannot be decrypted",
      );
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "credential-unreadable");
  });

  it("an unavailable host key answers 400 with host-key-unavailable and the detail", async () => {
    const app = await handlerApp(async () => {
      throw new InspectRepositoryError(
        "host-key-unavailable",
        "the host key of github.com could not be read",
        "example.com: Connection closed by remote host",
      );
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "ssh://git@github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "host-key-unavailable");
    assert.equal(
      response.body.error.details.detail,
      "example.com: Connection closed by remote host",
    );
  });

  it("a plain Error from the query answers 500 internal-error and is reported", async () => {
    const app = await handlerApp(async () => {
      throw new Error("boom");
    });
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "internal-error");
    assert.equal(response.body.error.message, "internal error");
    assert.equal(app.internalErrors().length, 1);
  });

  it("an http-basic inspect carries hostKey present with a null value", async () => {
    const app = await handlerApp(async () => result);
    const response = await app.post("/v1/repository/inspect").send({
      remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
      credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    });
    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn(response.body, "hostKey"), true);
    assert.equal(response.body.hostKey, null);
  });
});
