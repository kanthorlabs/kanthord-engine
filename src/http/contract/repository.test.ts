import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  repositoryInspectRequest,
  repositoryInspectResponse,
} from "./repository.ts";

const request = {
  remoteUrl: "https://x.test/r.git",
  credentialId: "provider_01",
};

const response = (
  write: { allowed: boolean; refusal: string | null } | null,
) => ({
  defaultBranch: "main",
  branches: ["main"],
  credential: { reachable: true, refusal: null },
  hostKey: null,
  access: {
    read: { allowed: true, refusal: null },
    write,
  },
});

describe("src/http/contract/repository.ts", () => {
  it("repositoryInspectRequest rejects extra fields", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      extra: true,
    });
    assert.equal(result.success, false);
  });

  it("repositoryInspectRequest accepts absent requiredAccess", () => {
    const result = repositoryInspectRequest.safeParse(request);
    assert.equal(result.success, true);
    if (!result.success) return;
    const data = result.data as typeof result.data & {
      requiredAccess?: "read" | "write";
    };
    assert.equal(data.requiredAccess, undefined);
  });

  it("repositoryInspectRequest accepts requiredAccess read", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      requiredAccess: "read",
    });
    assert.equal(result.success, true);
  });

  it("repositoryInspectRequest accepts requiredAccess write", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      requiredAccess: "write",
    });
    assert.equal(result.success, true);
  });

  it("repositoryInspectRequest rejects requiredAccess push", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      requiredAccess: "push",
    });
    assert.equal(result.success, false);
  });

  it("repositoryInspectRequest rejects requiredAccess Write (case sensitive)", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      requiredAccess: "Write",
    });
    assert.equal(result.success, false);
  });

  it("repositoryInspectRequest rejects requiredAccess empty string", () => {
    const result = repositoryInspectRequest.safeParse({
      ...request,
      requiredAccess: "",
    });
    assert.equal(result.success, false);
  });

  it("repositoryInspectResponse accepts access.write null", () => {
    const result = repositoryInspectResponse.safeParse(response(null));
    assert.equal(result.success, true);
  });

  it("repositoryInspectResponse accepts access.write non-null", () => {
    const result = repositoryInspectResponse.safeParse(
      response({ allowed: false, refusal: "auth-failed" }),
    );
    assert.equal(result.success, true);
  });

  it("repositoryInspectResponse rejects missing access", () => {
    const result = repositoryInspectResponse.safeParse({
      defaultBranch: "main",
      branches: ["main"],
      credential: { reachable: true, refusal: null },
      hostKey: null,
    });
    assert.equal(result.success, false);
  });

  it("repositoryInspectResponse rejects extra fields in access.read", () => {
    const result = repositoryInspectResponse.safeParse({
      ...response(null),
      access: {
        read: { allowed: true, refusal: null, extra: 1 },
        write: null,
      },
    });
    assert.equal(result.success, false);
  });
});
