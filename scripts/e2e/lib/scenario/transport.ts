import type {
  ExecutionDriver,
  HttpIssuer,
  DaemonConfig,
} from "../driver/index.ts";
import type { ScenarioContext } from "./context.ts";
import { resolveTools } from "./tools.ts";
import { secrets } from "../redact.ts";

export type TransportCase = Readonly<{
  name: string;
  token: "valid" | "wrong" | "absent";
  host: "allowed" | "foreign" | "absent";
  origin: string | null;
  expectedStatus: number;
  expectedCode: string | null;
}>;

export const transportCases: readonly TransportCase[] = [
  {
    name: "no-token",
    token: "absent",
    host: "allowed",
    origin: null,
    expectedStatus: 401,
    expectedCode: "unauthenticated",
  },
  {
    name: "wrong-token",
    token: "wrong",
    host: "allowed",
    origin: null,
    expectedStatus: 401,
    expectedCode: "unauthenticated",
  },
  {
    name: "origin-header",
    token: "valid",
    host: "allowed",
    origin: "http://evil.example",
    expectedStatus: 403,
    expectedCode: "origin-forbidden",
  },
  {
    name: "foreign-host",
    token: "valid",
    host: "foreign",
    origin: null,
    expectedStatus: 403,
    expectedCode: "host-forbidden",
  },
  {
    name: "absent-host",
    token: "valid",
    host: "absent",
    origin: null,
    expectedStatus: 403,
    expectedCode: "host-forbidden",
  },
  {
    name: "allowed-host",
    token: "valid",
    host: "allowed",
    origin: null,
    expectedStatus: 200,
    expectedCode: null,
  },
];

export async function runTransportCases(
  context: ScenarioContext,
  target: Readonly<{ allowedHost: string; token: string }>,
  issue: HttpIssuer,
): Promise<void> {
  if (target.token.length >= 8) {
    secrets.hold(target.token);
  }

  for (const row of transportCases) {
    const headers: Record<string, string> = {};

    if (row.token === "valid") {
      headers.Authorization = `Bearer ${target.token}`;
    } else if (row.token === "wrong") {
      headers.Authorization = `Bearer ${target.token}x`;
    }

    let omitHost = false;
    if (row.host === "allowed") {
      headers.Host = target.allowedHost;
    } else if (row.host === "foreign") {
      headers.Host = "not-allowed.invalid:1";
    } else {
      omitHost = true;
    }

    if (row.origin !== null) {
      headers.Origin = row.origin;
    }

    const response = await issue({
      method: "GET",
      path: "/v1/status",
      headers,
      omitHost,
    });

    context.assert(`${row.name}-status`, row.expectedStatus, response.status);

    let code: string | null = null;
    if (row.expectedCode !== null) {
      const parsed = JSON.parse(response.body) as Readonly<{
        error?: Readonly<{ code?: string }>;
      }>;
      code = parsed.error?.code ?? null;
      context.assert(`${row.name}-code`, row.expectedCode, code);
    }

    const requestLine = `GET /v1/status HTTP/1.1`;
    const headerLines = Object.entries(headers).map(([key, value]) =>
      key === "Authorization"
        ? `${key}: Bearer <${row.token}-token>`
        : `${key}: ${value}`,
    );
    const statusLine = `HTTP/1.1 ${String(response.status)}`;
    const logText = [requestLine, ...headerLines, statusLine].join("\n");
    context.attachLog?.(`${row.name}.http`, logText);
  }
}

export async function runStartupRefusal(
  context: ScenarioContext,
  driver: ExecutionDriver,
): Promise<void> {
  const config: DaemonConfig = {
    home: "/nonexistent/kanthord-e2e-startup-refusal",
    actor: "e2e-startup-refusal",
    masterKey: "0".repeat(64),
    http: {
      bind: "203.0.113.1",
      port: 0,
      token: "",
      allowedHosts: ["example.invalid"],
    },
    tools: resolveTools(),
    attemptLimit: 3,
    leaseTtlMs: 300000,
  };

  const record = await driver.startDaemonExpectingRefusal(config);

  context.assert("startup-refusal-exit", 1, record.exitCode);
  context.assert(
    "startup-refusal-message",
    "kanthord: config-refused: a non-loopback bind address requires http.token\n",
    record.stderr,
  );
}
