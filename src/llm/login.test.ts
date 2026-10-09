import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { BROWSER_UNAVAILABLE, isLoopbackHost, loginMode } from "./login.ts";
import { Platform } from "./platforms.ts";
import { LoginSessionMode } from "./sessions.ts";

test("isLoopbackHost accepts only a loopback name with an optional port", () => {
  for (const host of [
    "localhost:31415",
    "LOCALHOST",
    "127.0.0.1:31415",
    "127.0.0.2",
    "[::1]:31415",
  ])
    assert.equal(isLoopbackHost(host), true, host);
  for (const host of [
    "192.168.1.64:31415",
    "mac.tailnet.ts.net",
    "localhost.example.com",
    "[::]:31415",
    "",
  ])
    assert.equal(isLoopbackHost(host), false, host);
});

test("loginMode keeps browser mode for a browser on the server host", () => {
  assert.equal(
    loginMode(Platform.OpenAICodex, undefined, true),
    LoginSessionMode.Browser,
  );
  assert.equal(
    loginMode(Platform.OpenAICodex, LoginSessionMode.Browser, true),
    LoginSessionMode.Browser,
  );
  assert.equal(
    loginMode(Platform.OpenAICodex, LoginSessionMode.Device, true),
    LoginSessionMode.Device,
  );
});

test("loginMode selects device mode for a remote browser and refuses browser mode", () => {
  assert.equal(
    loginMode(Platform.OpenAICodex, undefined, false),
    LoginSessionMode.Device,
  );
  assert.equal(
    loginMode(Platform.OpenAICodex, LoginSessionMode.Device, false),
    LoginSessionMode.Device,
  );
  assert.equal(
    loginMode(Platform.GitHubCopilot, undefined, false),
    LoginSessionMode.Device,
  );
  assert.throws(
    () => loginMode(Platform.OpenAICodex, LoginSessionMode.Browser, false),
    (error) =>
      error instanceof OperationError &&
      error.code === BROWSER_UNAVAILABLE &&
      error.status === HttpStatus.BadRequest,
  );
});
