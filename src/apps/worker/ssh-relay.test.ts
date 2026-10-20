import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { background } from "../../kernel/context.ts";
import { OperationError } from "../../kernel/errors.ts";
import { isolatedGitEnvironment } from "../../kernel/git-environment.ts";
import {
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { sshSignRequestSchema } from "../../custody/contract.ts";
import type { SshRelayAccess } from "../../repository/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import {
  createBareRepository,
  relayedSignature,
  startTestSshd,
} from "../../repository/test-sshd.ts";
import { relaySigner } from "./ssh-relay.ts";
import { fakeInstanceServer, testClaim } from "./test-support.ts";
import { httpTransport } from "./transport.ts";

const execFileAsync = promisify(execFile);
const SIGN_PATH = "/api/worker/ssh/sign";
const DEADLINE_MS = 30_000;
const BASE_BRANCH = "main";
const NODE_FILE = "node.md";
const NODE_TEXT = "node\n";
const REQUEST_ID = "request_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const AUTHORIZATION_REFUSED = "project.authorization.refused";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const GIT_FAILED = "repository.connector.git_failed";
const NO_SIGNATURES = 0;

function failure(status: number, code: string, details: unknown = null) {
  return {
    status,
    body: { error: { code, message: code, details }, request_id: REQUEST_ID },
  };
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    env: isolatedGitEnvironment(hostEnvironment()),
  });
  return stdout.trim();
}

test("a worker pushes and fetches through the relay of a fixture server that holds a fixture claim", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey("deploy");
  await sshd.authorize(key.public_key);
  const server = await fakeInstanceServer(t);
  const binding = server.addBinding("coder");
  const token = `client-${binding.client_id}-1`;
  server.state.clientTokens.set(token, `connection_${createIdentity("node")}`);
  const claim = testClaim();
  const repositoryBinding = createIdentity("binding");
  const state = { live: true, signatures: NO_SIGNATURES };
  server.state.intercept = (request) => {
    if (request.path !== SIGN_PATH) return undefined;
    if (request.bearer !== token) return failure(401, UNAUTHORIZED);
    const body = request.body as {
      execution_id: string;
      nonce: string;
      ciphertext: string;
    };
    if (!state.live || body.execution_id !== claim.execution_id)
      return failure(403, PROOF_FAILED);
    const keys = deriveSshSignKeys(binding.client_secret);
    const aad = handoverAad(
      claim.execution_id,
      claim.claimant.runtime_identity,
    );
    const signRequest = sshSignRequestSchema.parse(
      openEnvelope(keys.request, aad, {
        nonce: body.nonce,
        ciphertext: body.ciphertext,
      }),
    );
    if (signRequest.binding_id !== repositoryBinding)
      return failure(403, AUTHORIZATION_REFUSED);
    try {
      const signature = relayedSignature(
        { ...key, known_hosts: sshd.known_hosts, port: sshd.port },
        Buffer.from(signRequest.data, "base64"),
        sshd.user,
      );
      state.signatures += 1;
      return {
        status: 200,
        body: sealEnvelope(keys.answer, aad, {
          signature: signature.toString("base64"),
        }),
      };
    } catch (error) {
      assert.ok(error instanceof OperationError);
      return failure(error.status, error.code, error.details);
    }
  };
  const relayAccess = (bindingId: string): SshRelayAccess => ({
    relay: relaySigner({
      api: httpTransport(server.endpoint, token),
      claim,
      clientSecret: binding.client_secret,
      bindingId,
    }),
    public_key: key.public_key,
    known_hosts: sshd.known_hosts,
    port: sshd.port,
  });
  const access = relayAccess(repositoryBinding);
  const transport = new RepositoryComponent();
  const url = sshd.url(bare);
  const directory = temporary(t);
  await transport.clone(url, directory, background, DEADLINE_MS, access);
  await git(directory, ["checkout", "-q", "-b", claim.node_branch]);
  await writeFile(join(directory, NODE_FILE), NODE_TEXT);
  await git(directory, ["add", NODE_FILE]);
  await git(directory, ["commit", "-q", "-m", "node"]);
  await transport.pushNodeBranch(
    directory,
    claim.node_branch,
    background,
    DEADLINE_MS,
    access,
  );
  assert.equal(
    await git(bare, ["rev-parse", claim.node_branch]),
    await git(directory, ["rev-parse", "HEAD"]),
  );
  assert.equal(
    await transport.fetchBase(
      directory,
      BASE_BRANCH,
      background,
      DEADLINE_MS,
      access,
    ),
    await git(bare, ["rev-parse", BASE_BRANCH]),
  );
  assert.ok(state.signatures > NO_SIGNATURES);
  const signed = state.signatures;
  await assert.rejects(
    transport.clone(
      url,
      temporary(t),
      background,
      DEADLINE_MS,
      relayAccess(createIdentity("binding")),
    ),
    { code: GIT_FAILED },
  );
  state.live = false;
  await assert.rejects(
    transport.clone(url, temporary(t), background, DEADLINE_MS, access),
    { code: GIT_FAILED },
  );
  assert.equal(state.signatures, signed);
});
