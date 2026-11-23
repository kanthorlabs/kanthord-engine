import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Diagnostic } from "../../kernel/errors.ts";
import { checkProxySettings } from "./run-agent-start.ts";

const ENV_PROXY = "cli.run.agent.env_proxy";
const FIELD_VARIABLES = "variables";
const FIELD_OPTION = "option";
const NODE_USE_ENV_PROXY_FLAG = "--use-env-proxy";
const NODE_USE_ENV_PROXY_VAR = "NODE_USE_ENV_PROXY";
const NODE_OPTIONS_VAR = "NODE_OPTIONS";

function assertDiagnostic(action: () => unknown, code: string): Diagnostic {
  let result: Diagnostic | undefined;
  assert.throws(action, (e: unknown) => {
    if (!(e instanceof Diagnostic)) return false;
    assert.equal(e.code, code);
    result = e;
    return true;
  });
  return result!;
}

describe("checkProxySettings", () => {
  it("passes with no proxy settings", () => {
    assert.doesNotThrow(() => checkProxySettings({}, []));
  });

  it("refuses NODE_USE_ENV_PROXY set to any value", () => {
    const error = assertDiagnostic(
      () => checkProxySettings({ NODE_USE_ENV_PROXY: "1" }, []),
      ENV_PROXY,
    );
    const row = error.fields.find(([name]) => name === FIELD_VARIABLES);
    assert.equal(row?.[1], NODE_USE_ENV_PROXY_VAR);
  });

  it("refuses NODE_USE_ENV_PROXY set to empty string", () => {
    assertDiagnostic(
      () => checkProxySettings({ NODE_USE_ENV_PROXY: "" }, []),
      ENV_PROXY,
    );
  });

  it("refuses --use-env-proxy in NODE_OPTIONS", () => {
    const error = assertDiagnostic(
      () =>
        checkProxySettings(
          { NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy" },
          [],
        ),
      ENV_PROXY,
    );
    const row = error.fields.find(([name]) => name === FIELD_VARIABLES);
    assert.equal(row?.[1], NODE_OPTIONS_VAR);
  });

  it("passes when NODE_OPTIONS holds other tokens", () => {
    assert.doesNotThrow(() =>
      checkProxySettings({ NODE_OPTIONS: "--max-old-space-size=512" }, []),
    );
  });

  it("refuses --use-env-proxy in execArgv", () => {
    const error = assertDiagnostic(
      () => checkProxySettings({}, ["--use-env-proxy"]),
      ENV_PROXY,
    );
    const row = error.fields.find(([name]) => name === FIELD_OPTION);
    assert.equal(row?.[1], NODE_USE_ENV_PROXY_FLAG);
  });

  it("refuses NODE_USE_ENV_PROXY before execArgv", () => {
    const error = assertDiagnostic(
      () =>
        checkProxySettings({ NODE_USE_ENV_PROXY: "1" }, ["--use-env-proxy"]),
      ENV_PROXY,
    );
    assert.ok(error.fields.some(([name]) => name === FIELD_VARIABLES));
  });
});
