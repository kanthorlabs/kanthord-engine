import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { servePort } from "../../gateway/index.ts";
import { intakeOperations } from "../../intake/contract.ts";
import { CancellationContext } from "../../kernel/context.ts";
import type { ClientOptions, Operation } from "../../kernel/operation.ts";
import { isObject, isString } from "../../kernel/values.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { missionOperations } from "../../mission/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  bridgePort,
  instanceFrameSchema,
  serverFrameSchema,
} from "../worker/frames.ts";
import { httpTransport, type WorkerTransport } from "../worker/transport.ts";
import { until } from "./cli-support.ts";
import {
  gatewayFixture,
  provisionNativeAgent,
  provisionNativeServerProject,
  provisionRepositoryCredentials,
  provisionWorkerProject,
} from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;
type Provision = Awaited<ReturnType<typeof provisionWorkerProject>>;
type ServiceName = keyof WorkerTransport;
type Closable = { close(): void };
type Link = (port: MessagePort, opened: Closable[]) => MessagePort;

interface Wire {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body: string | null;
}

interface Answer {
  data: { runtime_identity: string; execution?: { execution_id: string } };
}

interface Side {
  typed(
    actor: string,
    service: ServiceName,
    operation: string,
    input: unknown,
    deadlineMs?: number,
  ): Promise<unknown>;
  raw(actor: string, operation: Operation, wire: Wire): Promise<unknown>;
  logs(): Record<string, unknown>[];
}

interface Scenario {
  projects: {
    general: Provision;
    other: Provision;
    paused: Provision;
    placed: { id: string };
  };
  tokens: Record<string, string>;
}

const GENERAL = "general";
const OTHER = "other";
const PLACED = "placed";
const SINGLE_INSTANCE = 1;
const LIST_LIMIT = 2;
const PARKED_PULL_DEADLINE_MS = 500;
const OVERSIZED_BODY_PADDING = 1;
const PROVISIONING_ROUTE_PREFIX = "/api/project/";
const FINISHED_MESSAGE = "Request finished";
const ID_PATTERN = /\b([a-z_]+)_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const VOLATILE_SUFFIX = /(_at|_span_id|^trace_id)$/;
const VOLATILE_KEYS = new Set(["request_id", "idempotencyKey"]);
const EXPECTED_FAILURES = [
  ["registration above the count", 409, "worker.instance.slot_unavailable"],
  [
    "registration of a client that is no pool slot",
    409,
    "worker.instance.placement_mismatch",
  ],
  [
    "execution of another project",
    403,
    "gateway.invocation.execution_proof_failed",
  ],
  [
    "claim of another binding",
    403,
    "gateway.invocation.execution_proof_failed",
  ],
  [
    "human operation with a machine token",
    401,
    "gateway.authentication.unauthorized",
  ],
  ["deregistration of another client", 404, "worker.instance.not_found"],
  ["service operation", 404, "gateway.routing.not_found"],
  ["direct operation", 404, "gateway.routing.not_found"],
  ["body above the limit", 413, "gateway.request.body_too_large"],
  ["duplicate member body", 400, "gateway.request.invalid_json"],
  ["non-JSON body", 400, "gateway.request.invalid_json"],
  ["body on a no-body operation", 400, "gateway.request.unexpected_body"],
  ["call after binding removal", 401, "gateway.authentication.unauthorized"],
] as const;
const THREAD_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const ready = Promise.all([import(workerData.transportUrl), import(workerData.contextUrl)]);
const transports = new Map();
parentPort.on("message", async (message) => {
  const [{ portTransport }, { CancellationContext }] = await ready;
  if (message.kind === "attach") {
    transports.set(message.actor, portTransport(message.port));
    return;
  }
  try {
    const result = await transports.get(message.actor)[message.service][message.operation](message.input, message.deadlineMs === undefined ? {} : { context: new CancellationContext(undefined, Date.now() + message.deadlineMs) });
    parentPort.postMessage({ id: message.id, result: JSON.parse(JSON.stringify(result)) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, failure: String(error) });
  }
});
`;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !VOLATILE_KEYS.has(key) && !VOLATILE_SUFFIX.test(key),
        )
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  return value;
}

function placeholders(outcomes: unknown): unknown {
  const seen = new Map<string, number>();
  return JSON.parse(
    JSON.stringify(outcomes).replace(ID_PATTERN, (id, prefix: string) => {
      if (!seen.has(id)) seen.set(id, seen.size);
      return `${prefix}#${seen.get(id)}`;
    }),
  );
}

function pathOf(operation: Operation, wire: Wire): string {
  const path = operation.path.replace(
    /:([^/]+)/g,
    (_, key: string) => wire.params?.[key] ?? "",
  );
  const query = new URLSearchParams(wire.query).toString();
  return query ? `${path}?${query}` : path;
}

async function httpSide(fixture: Fixture, tokens: Scenario["tokens"]) {
  const mark = fixture.logs.length;
  return {
    logs: () => fixture.logs.slice(mark).map((line) => JSON.parse(line)),
    typed: async (
      actor: string,
      service: ServiceName,
      operation: string,
      input: unknown,
      deadlineMs?: number,
    ) => {
      const transport = httpTransport(fixture.endpoint, tokens[actor]);
      const call = (
        transport[service] as Record<
          string,
          (input: unknown, options: ClientOptions) => unknown
        >
      )[operation]!;
      return JSON.parse(
        JSON.stringify(
          await call(
            input,
            deadlineMs === undefined
              ? {}
              : {
                  context: new CancellationContext(
                    undefined,
                    Date.now() + deadlineMs,
                  ),
                },
          ),
        ),
      );
    },
    raw: async (actor: string, operation: Operation, wire: Wire) => {
      const response = await fetch(fixture.endpoint + pathOf(operation, wire), {
        method: operation.method,
        headers: {
          authorization: `Bearer ${tokens[actor]}`,
          ...(wire.body === null ? {} : { "content-type": "application/json" }),
        },
        body: wire.body,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      };
    },
  } satisfies Side;
}

const directLink: Link = (port) => port;

function failOnInvalid(error: Error): never {
  throw error;
}

const bridgeLink: Link = (port, opened) => {
  const toServer = new PassThrough();
  const toInstance = new PassThrough();
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  opened.push({ close: () => toServer.destroy() });
  opened.push({ close: () => toInstance.destroy() });
  bridgePort(port, toServer, toInstance, {
    frames: instanceFrameSchema,
    onFrame: () => {},
    onInvalid: failOnInvalid,
    onEnd: () => {},
  });
  bridgePort(port1, toInstance, toServer, {
    frames: serverFrameSchema,
    onFrame: () => {},
    onInvalid: failOnInvalid,
    onEnd: () => {},
  });
  return port2;
};

async function portSide(
  t: TestContext,
  fixture: Fixture,
  tokens: Scenario["tokens"],
  records: Record<string, unknown>[],
  link: Link,
) {
  const logger = pino(
    { level: "info" },
    { write: (line) => records.push(JSON.parse(line)) },
  );
  const thread = new Worker(THREAD_SOURCE, {
    eval: true,
    workerData: {
      transportUrl: new URL("../worker/transport.ts", import.meta.url).href,
      contextUrl: new URL("../../kernel/context.ts", import.meta.url).href,
    },
  });
  const opened: Closable[] = [];
  t.after(async () => {
    await thread.terminate();
    for (const port of opened) port.close();
  });
  const attached = new Set<string>();
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  thread.on(
    "message",
    (message: { id: number; result?: unknown; failure?: string }) => {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.failure !== undefined)
        entry?.reject(new Error(message.failure));
      else entry?.resolve(message.result);
    },
  );
  let sequence = 0;
  const serve = (actor: string) => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    servePort(port1, fixture.invocation, () => tokens[actor]!, logger);
    return link(port2, opened);
  };
  return {
    logs: () => records,
    typed: (
      actor: string,
      service: ServiceName,
      operation: string,
      input: unknown,
      deadlineMs?: number,
    ) => {
      if (!attached.has(actor)) {
        attached.add(actor);
        const port = serve(actor);
        thread.postMessage({ kind: "attach", actor, port }, [port]);
      }
      const id = sequence++;
      return new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        thread.postMessage({
          kind: "call",
          id,
          actor,
          service,
          operation,
          input,
          deadlineMs,
        });
      });
    },
    raw: (actor: string, operation: Operation, wire: Wire) => {
      const port = serve(actor);
      return new Promise<unknown>((resolve) => {
        port.once(
          "message",
          (answer: { status: number; body: string | null }) =>
            resolve({
              status: answer.status,
              body:
                isString(answer.body) && answer.body
                  ? JSON.parse(answer.body)
                  : answer.body,
            }),
        );
        port.postMessage({
          call_id: `call-${sequence++}`,
          operation_id: operation.id,
          params: wire.params ?? {},
          query: wire.query ?? {},
          body: wire.body,
        });
      });
    },
  } satisfies Side;
}

async function scenarioOf(fixture: Fixture, suffix: string): Promise<Scenario> {
  const general = await provisionWorkerProject(fixture, `general-${suffix}`, {
    [GENERAL]: SINGLE_INSTANCE,
    [OTHER]: SINGLE_INSTANCE,
  });
  const other = await provisionWorkerProject(fixture, `other-${suffix}`, {
    [GENERAL]: SINGLE_INSTANCE,
  });
  const paused = await provisionWorkerProject(fixture, `paused-${suffix}`, {
    [GENERAL]: SINGLE_INSTANCE,
  });
  await paused.pause();
  const placed = await provisionNativeServerProject(
    fixture,
    `placed-${suffix}`,
    PLACED,
  );
  const tokens = {
    a: await fixture.machineToken(general.id, GENERAL, "a"),
    b: await fixture.machineToken(general.id, GENERAL, "b"),
    o: await fixture.machineToken(general.id, OTHER, "o"),
    c: await fixture.machineToken(other.id, GENERAL, "c"),
    p: await fixture.machineToken(paused.id, GENERAL, "p"),
    s: await fixture.machineToken(placed.id, PLACED, "s"),
    h: fixture.token,
  };
  return { projects: { general, other, paused, placed }, tokens };
}

async function run(side: Side, scenario: Scenario) {
  const outcomes: [string, unknown][] = [];
  const record = async <T>(name: string, outcome: Promise<T>) => {
    const value = await outcome;
    outcomes.push([name, normalize(value)]);
    return value as Answer;
  };
  const empty = { params: {}, query: {}, body: null };
  const registration = await record(
    "registration",
    side.typed("a", "worker", "register", empty),
  );
  await record(
    "second registration of the same client",
    side.typed("a", "worker", "register", empty),
  );
  await record(
    "registration above the count",
    side.typed("b", "worker", "register", empty),
  );
  await record(
    "registration of a client that is no pool slot",
    side.typed("s", "worker", "register", empty),
  );
  await record("heartbeat", side.typed("a", "worker", "heartbeat", empty));
  const registeredOther = await record(
    "registration of the other binding",
    side.typed("o", "worker", "register", empty),
  );
  const registeredCrossProject = await record(
    "registration in the other project",
    side.typed("c", "worker", "register", empty),
  );
  const registeredPaused = await record(
    "registration in the paused project",
    side.typed("p", "worker", "register", empty),
  );
  const claimOther = await record(
    "pull of the other binding",
    side.typed("o", "scheduler", "workPull", {
      params: {},
      query: {},
      body: {
        resource_identity: `worker:kanthord:${OTHER}`,
        runtime_identity: registeredOther.data.runtime_identity,
      },
    }),
  );
  const claimCrossProject = await record(
    "pull in the other project",
    side.typed("c", "scheduler", "workPull", {
      params: {},
      query: {},
      body: {
        resource_identity: `worker:kanthord:${GENERAL}`,
        runtime_identity: registeredCrossProject.data.runtime_identity,
      },
    }),
  );
  await record(
    "pull of a paused project",
    side.typed(
      "p",
      "scheduler",
      "workPull",
      {
        params: {},
        query: {},
        body: {
          resource_identity: `worker:kanthord:${GENERAL}`,
          runtime_identity: registeredPaused.data.runtime_identity,
        },
      },
      PARKED_PULL_DEADLINE_MS,
    ),
  );
  await until(
    () => requestRecords(side.logs()),
    (records) =>
      records.some(
        (entry) =>
          entry.route === schedulerOperations.workPull.path &&
          entry.status === HttpStatus.ServiceUnavailable,
      ),
  );
  for (const [name, claim] of [
    ["execution of another project", claimCrossProject],
    ["claim of another binding", claimOther],
  ] as const)
    await record(
      name,
      side.typed("a", "worker", "execution.setup.get", {
        params: { execution_id: claim.data?.execution?.execution_id },
        query: {},
        body: null,
      }),
    );
  await record(
    "human operation with a machine token",
    side.typed("a", "worker", "catalog.list", {
      params: {},
      query: {},
      body: null,
    }),
  );
  await record(
    "deregistration of another client",
    side.typed("b", "worker", "instance.deregister", {
      params: { runtime_identity: registration.data.runtime_identity },
      query: {},
      body: null,
    }),
  );
  await record(
    "numeric query value",
    side.typed("h", "worker", "catalog.list", {
      params: {},
      query: { limit: LIST_LIMIT },
      body: null,
    }),
  );
  const serviceOperation = missionOperations["delivery.admit"];
  await record(
    "service operation",
    side.raw("a", serviceOperation, { body: "{}" }),
  );
  await record(
    "direct operation",
    side.raw("a", intakeOperations["action.perform"], {
      params: {
        execution_id: claimOther.data?.execution?.execution_id ?? "",
      },
      body: "{}",
    }),
  );
  const handover = workerOperations.handover;
  await record(
    "body above the limit",
    side.raw("a", handover, {
      body: JSON.stringify({
        execution_id: "x".repeat(
          (handover.maxBodyBytes ?? 0) + OVERSIZED_BODY_PADDING,
        ),
      }),
    }),
  );
  await record(
    "duplicate member body",
    side.raw("a", handover, {
      body: '{"execution_id":"a","execution_id":"b"}',
    }),
  );
  await record("non-JSON body", side.raw("a", handover, { body: "not json" }));
  await record(
    "body on a no-body operation",
    side.raw("a", workerOperations.heartbeat, { body: "{}" }),
  );
  await scenario.projects.general.rewrite({
    [OTHER]: SINGLE_INSTANCE,
  });
  await record(
    "call after binding removal",
    side.typed("a", "worker", "heartbeat", empty),
  );
  return outcomes;
}

function requestRecords(lines: Record<string, unknown>[]) {
  return lines
    .filter(
      (line) =>
        line.msg === FINISHED_MESSAGE &&
        !String(line.route).startsWith(PROVISIONING_ROUTE_PREFIX),
    )
    .map((line) => ({ route: line.route, status: line.status }));
}

test("the port transport, the bridged port transport and the HTTP transport answer the same through the Gateway", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  await provisionRepositoryCredentials(fixture);
  await provisionNativeAgent(fixture);
  const httpScenario = await scenarioOf(fixture, "http");
  const httpMark = fixture.logs.length;
  const http = await run(
    await httpSide(fixture, httpScenario.tokens),
    httpScenario,
  );
  const httpRecords = requestRecords(
    fixture.logs.slice(httpMark).map((line) => JSON.parse(line)),
  );
  const normalizedHttp = placeholders(http) as [string, unknown][];
  for (const [suffix, link] of [
    ["port", directLink],
    ["bridge", bridgeLink],
  ] as const) {
    const portScenario = await scenarioOf(fixture, suffix);
    const portLines: Record<string, unknown>[] = [];
    const port = await run(
      await portSide(t, fixture, portScenario.tokens, portLines, link),
      portScenario,
    );
    const normalizedPort = placeholders(port) as [string, unknown][];
    for (const [index, [name, outcome]] of normalizedHttp.entries())
      assert.deepEqual(
        normalizedPort[index],
        [name, outcome],
        `${suffix} ${name}`,
      );
    assert.deepEqual(requestRecords(portLines), httpRecords, suffix);
    const answered = new Map(normalizedPort);
    for (const [name, status, code] of EXPECTED_FAILURES) {
      const outcome = answered.get(name) as {
        status: number;
        error?: { error: { code: string } };
        body?: { error: { code: string } };
      };
      assert.equal(outcome.status, status, `${suffix} ${name}`);
      assert.equal(
        (outcome.error ?? outcome.body)?.error.code,
        code,
        `${suffix} ${name}`,
      );
    }
  }
});
