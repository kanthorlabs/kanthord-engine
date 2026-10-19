import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnvironment } from "./environment.ts";

test("the child environment holds no SSH agent of the host user", () => {
  const env = childEnvironment({
    PATH: "/bin",
    HOME: "/home/server",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SSH_AGENT_PID: "4242",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/server" });
});
