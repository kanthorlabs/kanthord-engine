import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import { GitError } from "../../../services/git/index.ts";
import { RegisterRepositoryError } from "../../../commands/repository/register-repository.ts";
import type { RegisterRepositoryInput } from "../../../commands/repository/register-repository.ts";
import { registerRepositoryHandler } from "./register-repository.ts";
import { repositoryRegisterResponse } from "../../contract/repository.ts";

type MockView = Readonly<{
  id: string;
  name: string;
  remoteUrl: string;
  credential: Readonly<{ id: string; name: string }>;
  upstreamBranch: string;
  landingBranch: string;
  landingRef: string;
  trackingRef: string;
  publishRef: string;
  publishOnApproval: boolean;
  state: "ready" | "needs-reconcile";
  landingOid: string | null;
  trackingOid: string | null;
  fetchedUpstreamOid: string | null;
  divergedLandingOid: string | null;
  divergedUpstreamOid: string | null;
  updatedAt: number;
}>;

const view: MockView = {
  id: "repo_01HZY8QF3M4N5P6R7S8T9V0W1A",
  name: "kanthord-verify",
  remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
  credential: {
    id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    name: "github-bot",
  },
  upstreamBranch: "main",
  landingBranch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: "1".repeat(40),
  trackingOid: "1".repeat(40),
  fetchedUpstreamOid: "f".repeat(40),
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: 1700000000000,
};

const validBody = {
  name: "kanthord-verify",
  remoteUrl: "https://github.com/kanthorlabs/kanthord-verify.git",
  credentialId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
  upstreamBranch: "main",
  landingBranch: "main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  hostFingerprint: null,
};

const expectedInput: RegisterRepositoryInput = {
  ...validBody,
  actor: bootstrapActorId,
};

const daemonHome = "/var/lib/kanthord";
const daemonPath = `${daemonHome}/repos/kanthord-verify/.git`;

async function handlerApp(
  registerRepository: (input: RegisterRepositoryInput) => Promise<MockView>,
) {
  return createTestApp({
    handlers: {
      "repository.register": registerRepositoryHandler({
        registerRepository,
      }),
    },
  });
}

function assertNoDaemonPath(body: unknown): void {
  const text = JSON.stringify(body);
  assert.equal(text.includes(daemonHome), false, text);
  assert.equal(/\/\.git/.test(text), false, text);
}

describe("src/http/server/repository/register-repository.test", () => {
  it("POST /v1/repository with a valid body answers 200 and the response schema parses the body", async () => {
    let called: RegisterRepositoryInput | undefined;
    const app = await handlerApp(async (input) => {
      called = input;
      return view;
    });
    const response = await app.post("/v1/repository").send(validBody);
    assert.equal(response.status, 200);
    assert.equal(
      repositoryRegisterResponse.safeParse(response.body).success,
      true,
    );
    assert.deepEqual(called, expectedInput);
    assertNoDaemonPath(response.body);
  });

  it("a body missing upstreamBranch answers 400 and never calls the command", async () => {
    let calls = 0;
    const app = await handlerApp(async () => {
      calls += 1;
      return view;
    });
    const { upstreamBranch: _omit, ...body } = validBody;
    const response = await app.post("/v1/repository").send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("a body missing landingBranch answers 400 and never calls the command", async () => {
    let calls = 0;
    const app = await handlerApp(async () => {
      calls += 1;
      return view;
    });
    const { landingBranch: _omit, ...body } = validBody;
    const response = await app.post("/v1/repository").send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("a body missing publishRef answers 400 and never calls the command", async () => {
    let calls = 0;
    const app = await handlerApp(async () => {
      calls += 1;
      return view;
    });
    const { publishRef: _omit, ...body } = validBody;
    const response = await app.post("/v1/repository").send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("a name carrying a slash or an upper-case letter answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, name: "Kanthord/Verify" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("an upstreamBranch escaping the tree answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, upstreamBranch: "../etc" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("an upstreamBranch with a leading dash answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, upstreamBranch: "-x" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a landingBranch ending in .lock answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, landingBranch: "main.lock" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a publishRef that is not fully qualified answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, publishRef: "main" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a malformed hostFingerprint answers 400", async () => {
    const app = await handlerApp(async () => view);
    const response = await app
      .post("/v1/repository")
      .send({ ...validBody, hostFingerprint: "nope" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("an absent publishOnApproval reaches the command as true and an absent hostFingerprint as null", async () => {
    let called: RegisterRepositoryInput | undefined;
    const app = await handlerApp(async (input) => {
      called = input;
      return view;
    });
    const {
      publishOnApproval: _omitApproval,
      hostFingerprint: _omitFingerprint,
      ...body
    } = validBody;
    const response = await app.post("/v1/repository").send(body);
    assert.equal(response.status, 200);
    assert.equal(called?.publishOnApproval, true);
    assert.equal(called?.hostFingerprint, null);
  });

  type RefusalRow = Readonly<{
    name: string;
    build: () => Error;
    status: number;
    code: string;
    assertDetails?: (body: unknown) => void;
  }>;

  const refusalRows: readonly RefusalRow[] = [
    {
      name: "name-taken",
      build: () =>
        new RegisterRepositoryError(
          "name-taken",
          "a repository named kanthord-verify is already registered",
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "name-taken",
        ),
    },
    {
      name: "credential-not-found",
      build: () =>
        new RegisterRepositoryError(
          "credential-not-found",
          "no provider provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
        ),
      status: 404,
      code: "not-found",
    },
    {
      name: "credential-wrong-kind",
      build: () =>
        new RegisterRepositoryError(
          "credential-wrong-kind",
          "provider x is of kind llm; repository.register needs kind git",
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "credential-wrong-kind",
        ),
    },
    {
      name: "credential-unreadable",
      build: () =>
        new RegisterRepositoryError(
          "credential-unreadable",
          "the payload of provider x cannot be opened",
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "credential-unreadable",
        ),
    },
    {
      name: "host-fingerprint-required",
      build: () =>
        new RegisterRepositoryError(
          "host-fingerprint-required",
          "an ssh url needs a confirmed hostFingerprint",
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "host-fingerprint-required",
        ),
    },
    {
      name: "host-fingerprint-forbidden",
      build: () =>
        new RegisterRepositoryError(
          "host-fingerprint-forbidden",
          "an http-basic url has no host key",
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "host-fingerprint-forbidden",
        ),
    },
    {
      name: "host-key-mismatch",
      build: () =>
        new RegisterRepositoryError(
          "host-key-mismatch",
          "the host presented no key matching SHA256:supplied",
          {
            presented: ["SHA256:aaa", "SHA256:bbb"],
            confirmed: "SHA256:supplied",
          },
        ),
      status: 409,
      code: "host-key-mismatch",
      assertDetails: (body) => {
        const details = (
          body as {
            error: { details: { presented: string[]; confirmed: string } };
          }
        ).error.details;
        assert.deepEqual(details.presented, ["SHA256:aaa", "SHA256:bbb"]);
        assert.equal(details.confirmed, "SHA256:supplied");
      },
    },
    {
      name: "host-key-unavailable",
      build: () =>
        new RegisterRepositoryError(
          "host-key-unavailable",
          "the host key of github.com could not be read",
          { detail: "github.com: Connection closed by remote host" },
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) => {
        const details = (
          body as {
            error: { details: { refusal: string; detail: string } };
          }
        ).error.details;
        assert.equal(details.refusal, "host-key-unavailable");
        assert.equal(
          details.detail,
          "github.com: Connection closed by remote host",
        );
      },
    },
    {
      name: "outside-writer",
      build: () =>
        new RegisterRepositoryError(
          "outside-writer",
          "the repository ref moved outside the daemon",
          { expectedOid: "e".repeat(40), observedOid: "o".repeat(40) },
        ),
      status: 409,
      code: "stale-revision",
      assertDetails: (body) => {
        const details = (
          body as {
            error: { details: { expectedOid: string; observedOid: string } };
          }
        ).error.details;
        assert.equal(details.expectedOid, "e".repeat(40));
        assert.equal(details.observedOid, "o".repeat(40));
      },
    },
    {
      name: "git-url-refused",
      build: () =>
        new GitError(
          "url-refused",
          "the scheme ftp is not allowed",
          daemonPath,
        ),
      status: 400,
      code: "invalid-request",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { refusal: string } } }).error.details
            .refusal,
          "url-refused",
        ),
    },
    {
      name: "git-auth-failed",
      build: () =>
        new GitError(
          "auth-failed",
          "the credential may not push to refs/heads/main",
          daemonPath,
        ),
      status: 422,
      code: "credential-rejected",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { failure: string } } }).error.details
            .failure,
          "auth-failed",
        ),
    },
    {
      name: "git-permission-denied",
      build: () =>
        new GitError(
          "permission-denied",
          "the credential may not push to refs/heads/main",
          daemonPath,
        ),
      status: 422,
      code: "credential-rejected",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { failure: string } } }).error.details
            .failure,
          "permission-denied",
        ),
    },
    {
      name: "git-host-key-mismatch",
      build: () =>
        new GitError(
          "host-key-mismatch",
          "the host key changed since registration",
          daemonPath,
        ),
      status: 409,
      code: "host-key-mismatch",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { details: { failure: string } } }).error.details
            .failure,
          "host-key-mismatch",
        ),
    },
    {
      name: "git-unclassified",
      build: () => new GitError("lock-held", "the ref is locked", daemonPath),
      status: 500,
      code: "internal-error",
      assertDetails: (body) =>
        assert.equal(
          (body as { error: { message: string } }).error.message,
          "internal error",
        ),
    },
  ];

  for (const row of refusalRows) {
    it(`the refusal row ${row.name} answers ${row.status} with ${row.code}`, async () => {
      const app = await handlerApp(async () => {
        throw row.build();
      });
      const response = await app.post("/v1/repository").send(validBody);
      assert.equal(response.status, row.status, row.name);
      assert.equal(response.body.error.code, row.code, row.name);
      if (row.assertDetails !== undefined) {
        row.assertDetails(response.body);
      }
      assertNoDaemonPath(response.body);
    });
  }

  it("an unclassified GitError is reported once on internal error", async () => {
    const app = await handlerApp(async () => {
      throw new GitError("lock-held", "the ref is locked", daemonPath);
    });
    const response = await app.post("/v1/repository").send(validBody);
    assert.equal(response.status, 500);
    assert.equal(app.internalErrors().length, 1);
  });
});
