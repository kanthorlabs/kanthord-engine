import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { gatewayOperations } from "../../gateway/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { temporary } from "../../kernel/test-support.ts";
import { CheckErrorCode } from "../../repository/check.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

test("E04.1 serve refuses startup when git is absent from PATH", async (t) => {
  const dir = temporary(t);
  const cfgPath = join(dir, "kanthord.yaml");
  const baseEnv = {
    ...environment(dir),
    KANTHORD_CONFIG: cfgPath,
    XDG_DATA_HOME: join(dir, "data"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  for (const path of [baseEnv.XDG_DATA_HOME, baseEnv.XDG_STATE_HOME])
    mkdirSync(join(path, "kanthord"), { mode: 0o700, recursive: true });
  const initResult = await kanthord(["config", "init"], baseEnv);
  assert.equal(initResult.code, EXIT_SUCCESS, initResult.stderr);
  assert.ok(existsSync(cfgPath));

  const toolsDir = join(dir, "tools");
  mkdirSync(toolsDir);
  for (const tool of ["bash", "ssh"]) {
    const toolPath = execFileSync("which", [tool]).toString().trim();
    assert.ok(isAbsolute(toolPath), toolPath);
    assert.ok(existsSync(toolPath), toolPath);
    symlinkSync(toolPath, join(toolsDir, tool));
  }
  const result = await kanthord(["serve"], { ...baseEnv, PATH: toolsDir });
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(
    result.stderr.startsWith(CheckErrorCode.ToolMissing + ": git: not found"),
    result.stderr,
  );
});

test("E04.2 GET /api/liveness returns repository.toolchain map", async (t) => {
  const fixture = await gatewayFixture(t);
  const response = await fixture.request(gatewayOperations.liveness.path);
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.liveness.output.parse(await response.json());
  assert.deepEqual(body.services.repository, {
    toolchain: HealthStatus.Healthy,
  });
});
