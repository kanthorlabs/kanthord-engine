import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { ulid } from "ulid";
import { stringify } from "yaml";
import {
  generateX25519KeyPair,
  keyFingerprint,
  sealJSON,
} from "../../kernel/hpke.ts";
import { stopAfter } from "../../kernel/test-support.ts";
import { isString } from "../../kernel/values.ts";
import { packageVersion } from "../../kernel/version.ts";
import {
  INSTANCE_CONNECTION_INFO,
  type InstanceConfiguration,
  instanceConfigurationValue,
  WORKER_TOKEN_INFO,
} from "../../worker/contract.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";

export function testClaim(): ExecutionRecord {
  return {
    execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    project_id: "project_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    node_id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    claimant: {
      worker_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      runtime_identity: "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      resource_identity: "worker:kanthord:test",
    },
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    credentials: [],
    agent_selections: [],
    claim_state: "running",
    expired_at: Date.now() + 60000,
    created_at: Date.now(),
    ended_at: null,
    stop: null,
    trace_id: "1".repeat(32),
    root_span_id: "2".repeat(16),
  };
}

export const FAKE_INSTANCE_NAME = "laptop";
export const FAKE_WORKER = "coder@1";
export const FakePath = {
  OpenAPI: "/api/openapi.yaml",
  Token: "/api/worker/instance/token",
  Connect: "/api/worker/instance/connect",
  InstanceHeartbeat: "/api/worker/instance/heartbeat",
  Register: "/api/worker/register",
  Heartbeat: "/api/worker/heartbeat",
  Pull: "/api/scheduler/work/pull",
  Handover: "/api/worker/handover",
  Deregister: "/api/worker/registration/",
} as const;
const UNAUTHORIZED_CODE = "gateway.authentication.unauthorized";
const SUPERSEDED_CODE = "worker.instance.connection_superseded";
const JWT_SUPERSEDED_CODE = "gateway.jwt.connection_superseded";
const REQUEST_ID = "request_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const TOKEN_LIFETIME_MS = 3600000;
const LOOPBACK = "127.0.0.1";
const BEARER_PREFIX = "Bearer ";

export interface FakeBinding {
  project_id: string;
  resource_identity: string;
  client_id: string;
  client_secret: string;
  state: "serving" | "draining";
}

export interface FakeRequest {
  method: string;
  path: string;
  bearer: string | null;
  body: unknown;
}

const HOLD = "hold";
type Answer = { status: number; body: unknown } | typeof HOLD;

function failure(status: number, code: string, details?: unknown) {
  return {
    status,
    body: {
      error: { code, message: code, details: details ?? null },
      request_id: REQUEST_ID,
    },
  };
}

export async function fakeInstanceServer(t: TestContext) {
  const pair = await generateX25519KeyPair();
  const instanceId = `worker_instance_${ulid()}`;
  const state = {
    version: packageVersion(),
    bindingVersion: 0,
    serial: 0,
    current: null as { id: string; name: string } | null,
    workerTokens: new Set<string>(),
    clientTokens: new Map<string, string>(),
    bindings: [] as FakeBinding[],
    runtimes: new Map<string, string>(),
    requests: [] as FakeRequest[],
    deregistered: [] as string[],
    revoked: false,
    intercept: undefined as
      | ((
          request: FakeRequest,
        ) => Answer | undefined | Promise<Answer | undefined>)
      | undefined,
  };
  const workerToken = (bearer: string | null) =>
    !state.revoked && bearer !== null && state.workerTokens.has(bearer);
  const clientOf = (bearer: string | null) =>
    bearer === null || state.revoked
      ? undefined
      : state.clientTokens.get(bearer);
  const sealedConnection = async (connectionId: string) => {
    const bindings = state.bindings.map((binding) => {
      const token = `client-${binding.client_id}-${++state.serial}`;
      state.clientTokens.set(token, connectionId);
      return {
        ...binding,
        token,
        expired_at: Date.now() + TOKEN_LIFETIME_MS,
      };
    });
    return {
      connection_id: connectionId,
      binding_version: state.bindingVersion,
      sealed: await sealJSON(
        pair.public_key,
        INSTANCE_CONNECTION_INFO,
        `${instanceId}${connectionId}`,
        { bindings },
      ),
    };
  };
  const clientBinding = (bearer: string | null) => {
    const connection = clientOf(bearer);
    if (connection === undefined) return failure(401, UNAUTHORIZED_CODE);
    if (state.current && state.current.id !== connection)
      return failure(401, JWT_SUPERSEDED_CODE);
    const clientId = bearer!.split("-")[1]!;
    return state.bindings.find((binding) => binding.client_id === clientId)!;
  };
  async function answer(request: FakeRequest): Promise<Answer> {
    const intercepted = await state.intercept?.(request);
    if (intercepted) return intercepted;
    const body = request.body as Record<string, unknown> | null;
    if (request.path === FakePath.OpenAPI)
      return {
        status: 200,
        body: stringify({ info: { version: state.version } }),
      };
    if (request.path === FakePath.Token) {
      if (body?.instance_id !== instanceId)
        return failure(404, "worker.instance.not_found");
      const token = `worker-${++state.serial}`;
      state.workerTokens.add(token);
      return {
        status: 200,
        body: {
          server_version: state.version,
          sealed: await sealJSON(
            pair.public_key,
            WORKER_TOKEN_INFO,
            instanceId,
            {
              token,
              expired_at: Date.now() + TOKEN_LIFETIME_MS,
              name: FAKE_INSTANCE_NAME,
              worker: FAKE_WORKER,
              fingerprint: keyFingerprint(pair.public_key),
            },
          ),
        },
      };
    }
    if (
      request.path === FakePath.Connect ||
      request.path === FakePath.InstanceHeartbeat
    ) {
      if (!workerToken(request.bearer)) return failure(401, UNAUTHORIZED_CODE);
      const requested = body?.connection_id as string | undefined;
      if (request.path === FakePath.Connect && requested === undefined) {
        state.current = {
          id: `connection_${ulid()}`,
          name: String(body?.connection_name),
        };
        return { status: 200, body: await sealedConnection(state.current.id) };
      }
      if (state.current && state.current.id !== requested)
        return failure(409, SUPERSEDED_CODE, {
          connection_name: state.current.name,
        });
      state.current ??= {
        id: requested!,
        name: String(body?.connection_name ?? ""),
      };
      if (request.path === FakePath.Connect)
        return { status: 200, body: await sealedConnection(requested!) };
      return {
        status: 200,
        body: {
          server_version: state.version,
          binding_version: state.bindingVersion,
          credential_version: 0,
          login_sessions: [],
        },
      };
    }
    const binding = clientBinding(request.bearer);
    if ("status" in binding) return binding;
    if (request.path === FakePath.Register) {
      let runtime = state.runtimes.get(binding.client_id);
      if (!runtime) {
        runtime = `worker_registration_${ulid()}`;
        state.runtimes.set(binding.client_id, runtime);
      }
      return {
        status: 200,
        body: {
          runtime_identity: runtime,
          resource_identity: binding.resource_identity,
          worker_name: FAKE_WORKER,
        },
      };
    }
    if (request.path === FakePath.Heartbeat) return { status: 200, body: null };
    if (request.path.startsWith(FakePath.Deregister)) {
      const runtime = request.path.slice(FakePath.Deregister.length);
      state.deregistered.push(runtime);
      state.runtimes.delete(binding.client_id);
      return {
        status: 200,
        body: { runtime_identity: runtime, registered: false },
      };
    }
    if (request.path === FakePath.Pull) return HOLD;
    return failure(404, "gateway.routing.not_found");
  }
  const listener = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const authorization = incoming.headers.authorization;
      const request: FakeRequest = {
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        bearer: authorization?.startsWith(BEARER_PREFIX)
          ? authorization.slice(BEARER_PREFIX.length)
          : null,
        body: text ? JSON.parse(text) : null,
      };
      state.requests.push(request);
      void answer(request).then((result) => {
        if (result === HOLD) return;
        const yaml = request.path === FakePath.OpenAPI;
        response.writeHead(result.status, {
          "Content-Type": yaml ? "application/yaml" : "application/json",
        });
        response.end(yaml ? String(result.body) : JSON.stringify(result.body));
      });
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, LOOPBACK, resolve));
  stopAfter(
    t,
    () =>
      new Promise<void>((resolve) => {
        listener.closeAllConnections();
        listener.close(() => resolve());
      }),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const endpoint = `http://${LOOPBACK}:${address.port}`;
  const configuration: InstanceConfiguration = {
    name: FAKE_INSTANCE_NAME,
    endpoint,
    instance_id: instanceId,
    private_key: pair.private_key.toString("base64url"),
  };
  const addBinding = (name: string, project = `project_${ulid()}`) => {
    const binding: FakeBinding = {
      project_id: project,
      resource_identity: `worker:kanthord:${name}`,
      client_id: `client_identity_${ulid()}`,
      client_secret: randomBytes(32).toString("base64"),
      state: "serving",
    };
    state.bindings.push(binding);
    return binding;
  };
  return {
    state,
    endpoint,
    instanceId,
    configuration,
    value: instanceConfigurationValue(configuration),
    addBinding,
    requestsTo: (path: string) =>
      state.requests.filter((request) => request.path.startsWith(path)),
  };
}
