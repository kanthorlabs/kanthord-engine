import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerDbStatus } from "./status.ts";
import type { ClientDependencies } from "../client.ts";
import { KANTHORD_VERSION } from "../../domain/version.ts";
import {
  registerClientOptions,
  requireBaseUrl,
  resolveClientOptions,
} from "../options.ts";
import { exitCodeForError } from "../exit-code.ts";

const twoLineBody = {
  migrations: [
    {
      version: 1,
      name: "0001-core-entities",
      applied: true,
      appliedAt: 1700000000,
    },
    {
      version: 2,
      name: "0002-graph-and-plan",
      applied: false,
      appliedAt: null,
    },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const envelopeResponse = (
  code: string,
  message: string,
  status: number,
): Response => jsonResponse({ error: { code, message } }, status);

const harness = (
  env: Readonly<Record<string, string | undefined>>,
  respond: (url: string, init: RequestInit) => Response,
): {
  program: Command;
  fetchCalls: readonly Readonly<{ url: string; init: RequestInit }>[];
  stdoutText(): string;
  stderrText(): string;
  exitCodes(): readonly number[];
} => {
  const program = new Command();
  registerClientOptions(program);
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const client: () => ClientDependencies = () => {
    const options = resolveClientOptions({ program, env });
    return {
      baseUrl: requireBaseUrl(options),
      token: options.token,
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : String(input);
        const requestInit = init ?? {};
        fetchCalls.push({ url, init: requestInit });
        return Promise.resolve(respond(url, requestInit));
      },
    };
  };
  let stdoutText = "";
  let stderrText = "";
  const exitCodes: number[] = [];
  registerDbStatus({
    program,
    client,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  return {
    program,
    fetchCalls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    exitCodes: () => exitCodes,
  };
};

const run = async (
  program: Command,
  args: readonly string[] = ["db", "status"],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

const baseUrlEnv = { KANTHORD_BASE_URL: "http://127.0.0.1:7421" };

describe("src/cli/db/status.test", () => {
  it("a 200 body prints one applied or pending line per migration", async () => {
    const h = harness(baseUrlEnv, () => jsonResponse(twoLineBody));
    await run(h.program);

    assert.equal(
      h.stdoutText(),
      "0001-core-entities applied\n0002-graph-and-plan pending\n",
    );
    assert.equal(h.stderrText(), "");
    assert.deepEqual(h.exitCodes(), []);
  });

  it("an empty migrations list prints no stdout line", async () => {
    const h = harness(baseUrlEnv, () => jsonResponse({ migrations: [] }));
    await run(h.program);

    assert.equal(h.stdoutText(), "");
    assert.deepEqual(h.exitCodes(), []);
  });

  it("the request carries GET, the db status path and the client version", async () => {
    const h = harness(baseUrlEnv, () => jsonResponse({ migrations: [] }));
    await run(h.program);

    assert.equal(h.fetchCalls.length, 1);
    const call = h.fetchCalls[0]!;
    assert.equal(call.init.method, "GET");
    assert.ok(call.url.endsWith("/v1/db/status"), call.url);
    const headers = call.init.headers as Readonly<Record<string, string>>;
    assert.equal(headers["X-Kanthord-Client"], KANTHORD_VERSION);
  });

  it("a --token flag carries the Authorization header", async () => {
    const h = harness(baseUrlEnv, () => jsonResponse({ migrations: [] }));
    await run(h.program, ["--token", "t", "db", "status"]);

    const headers = h.fetchCalls[0]!.init.headers as Readonly<
      Record<string, string>
    >;
    assert.equal(headers.Authorization, "Bearer t");
  });

  it("a 401 envelope prints the refusal and exits 120", async () => {
    const h = harness(baseUrlEnv, () =>
      envelopeResponse("unauthenticated", "the bearer token is not valid", 401),
    );
    await run(h.program);

    assert.equal(
      h.stderrText(),
      "kanthord: unauthenticated: the bearer token is not valid\n",
    );
    assert.equal(h.stdoutText(), "");
    assert.deepEqual(h.exitCodes(), [120]);
  });

  it("a 501 envelope exits 220", async () => {
    const h = harness(baseUrlEnv, () =>
      envelopeResponse(
        "not-implemented",
        "system.db is not implemented yet",
        501,
      ),
    );
    await run(h.program);

    assert.deepEqual(h.exitCodes(), [220]);
  });

  it("a 500 non-envelope response exits 210 with the internal-error line", async () => {
    const h = harness(baseUrlEnv, () =>
      jsonResponse({ not: "an envelope" }, 500),
    );
    await run(h.program);

    assert.equal(
      h.stderrText(),
      "kanthord: internal-error: the daemon answered 500 with no error envelope\n",
    );
    assert.deepEqual(h.exitCodes(), [210]);
  });

  it("no base url and no KANTHORD_BASE_URL exits 1 and never calls fetch", async () => {
    const h = harness({}, () => jsonResponse({ migrations: [] }));
    await run(h.program);

    assert.equal(
      h.stderrText(),
      "kanthord: cli-base-url-missing: no daemon base url; set --base-url, KANTHORD_BASE_URL or a discovered config\n",
    );
    assert.deepEqual(h.exitCodes(), [1]);
    assert.deepEqual(h.fetchCalls, []);
  });

  it("a 200 body that fails the contract schema rejects", async () => {
    const h = harness(baseUrlEnv, () =>
      jsonResponse({ migrations: [{ version: 1 }] }),
    );

    await assert.rejects(() => run(h.program));
  });

  it("exit codes are routed on the code, never on the message", () => {
    assert.equal(exitCodeForError("unauthenticated", 401), 120);
    assert.equal(exitCodeForError("not-implemented", 501), 220);
    assert.equal(exitCodeForError("internal-error", 500), 210);
  });
});
