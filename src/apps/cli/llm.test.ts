import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import { ExitCode } from "./constants.ts";
import { runKanthord } from "./test-support.ts";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_ID = "login_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = "https://github.com/login/device";
const EXPIRES_AT = Date.UTC(2026, 9, 17, 22, 33, 40, 960);
const EXPIRES_AT_TEXT = "2026-10-17T22:33:40.960Z";
const LOGIN_PATH = "/api/llm/credential/login";
const EMPTY_OUTPUT = "";

async function loginServer(
  t: TestContext,
  code: string | null,
): Promise<string> {
  const server = createServer((request, response) => {
    assert.equal(request.url, LOGIN_PATH);
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        session_id: SESSION_ID,
        address: ADDRESS,
        code,
        expires_at: EXPIRES_AT,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(t: TestContext, code: string | null) {
  const directory = temporary(t);
  return runKanthord(
    [
      "llm",
      "credential",
      "login",
      "github-copilot",
      "--name",
      "copilot",
      "--endpoint",
      await loginServer(t, code),
      "--token",
      "human",
      "--idempotency-key",
      KEY,
    ],
    {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    },
    t.signal,
  );
}

test("login prints aligned rows and the address alone after an empty line", async (t) => {
  const result = await login(t, "ABCD-EFGH");
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.equal(
    result.stdout,
    `session_id:      ${SESSION_ID}\ncode:            ABCD-EFGH\nexpires_at:      ${EXPIRES_AT_TEXT}\nidempotency_key: ${KEY}\n\naddress:\n${ADDRESS}\n`,
  );
});

test("login omits the code row when the answer has no code", async (t) => {
  const result = await login(t, null);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(
    result.stdout,
    `session_id:      ${SESSION_ID}\nexpires_at:      ${EXPIRES_AT_TEXT}\nidempotency_key: ${KEY}\n\naddress:\n${ADDRESS}\n`,
  );
});
