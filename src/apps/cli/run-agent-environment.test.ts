import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_CREDENTIAL_NAMES,
  PROXY_NAMES,
  withoutAmbientCredentials,
} from "./run-agent-environment.ts";

const AMBIENT_COUNT = 47;
const PROXY_COUNT = 8;
const AGENT_HOME = "/run/agent/home";
const AGENT_TMP = "/run/agent/tmp";
const AWS_CONFIG_PATH = "/run/agent/home/.aws/config";
const AWS_CREDENTIALS_PATH = "/run/agent/home/.aws/credentials";
const EC2_METADATA_VALUE = "true";
const METADATA_DETECTION_VALUE = "none";
const PATH_VALUE = "/usr/bin:/usr/local/bin";
const LANG_VALUE = "en_US.UTF-8";

describe("AMBIENT_CREDENTIAL_NAMES", () => {
  it("contains 47 names", () => {
    assert.equal(AMBIENT_CREDENTIAL_NAMES.length, AMBIENT_COUNT);
  });

  it("includes AWS credential names", () => {
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AWS_ACCESS_KEY_ID"));
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AWS_SECRET_ACCESS_KEY"));
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AWS_SESSION_TOKEN"));
  });

  it("includes Google credential names", () => {
    assert.ok(
      AMBIENT_CREDENTIAL_NAMES.includes("GOOGLE_APPLICATION_CREDENTIALS"),
    );
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("GOOGLE_API_KEY"));
  });

  it("includes Azure credential names", () => {
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AZURE_CLIENT_ID"));
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AZURE_CLIENT_SECRET"));
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("AZURE_OPENAI_API_KEY"));
  });

  it("includes Anthropic names", () => {
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("ANTHROPIC_ORGANIZATION_ID"));
    assert.ok(AMBIENT_CREDENTIAL_NAMES.includes("ANTHROPIC_WORKSPACE_ID"));
  });
});

describe("PROXY_NAMES", () => {
  it("contains exactly 8 names", () => {
    assert.equal(PROXY_NAMES.length, PROXY_COUNT);
  });

  it("includes upper and lower case forms", () => {
    assert.ok(PROXY_NAMES.includes("HTTP_PROXY"));
    assert.ok(PROXY_NAMES.includes("http_proxy"));
    assert.ok(PROXY_NAMES.includes("HTTPS_PROXY"));
    assert.ok(PROXY_NAMES.includes("https_proxy"));
    assert.ok(PROXY_NAMES.includes("ALL_PROXY"));
    assert.ok(PROXY_NAMES.includes("all_proxy"));
    assert.ok(PROXY_NAMES.includes("NO_PROXY"));
    assert.ok(PROXY_NAMES.includes("no_proxy"));
  });
});

describe("withoutAmbientCredentials", () => {
  it("removes ambient credential names from env", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/old-home",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "fixture-secret",
      GOOGLE_API_KEY: "fixture-google-key",
    };
    withoutAmbientCredentials(env, "/run/home", "/run/tmp");
    assert.equal(env["AWS_ACCESS_KEY_ID"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
    assert.equal(env["GOOGLE_API_KEY"], undefined);
  });

  it("removes proxy names from env", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.example:3128",
      http_proxy: "http://proxy.example:3128",
      HTTPS_PROXY: "http://proxy.example:3128",
      https_proxy: "http://proxy.example:3128",
      ALL_PROXY: "socks5://proxy.example:1080",
      all_proxy: "socks5://proxy.example:1080",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    };
    withoutAmbientCredentials(env, "/run/home", "/run/tmp");
    for (const name of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ])
      assert.equal(env[name], undefined);
  });

  it("sets HOME and TMPDIR from given paths", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/old" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["HOME"], AGENT_HOME);
    assert.equal(env["TMPDIR"], AGENT_TMP);
  });

  it("sets AWS config path variables under home", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["AWS_CONFIG_FILE"], AWS_CONFIG_PATH);
    assert.equal(env["AWS_SHARED_CREDENTIALS_FILE"], AWS_CREDENTIALS_PATH);
  });

  it("sets AWS_EC2_METADATA_DISABLED and METADATA_SERVER_DETECTION", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["AWS_EC2_METADATA_DISABLED"], EC2_METADATA_VALUE);
    assert.equal(env["METADATA_SERVER_DETECTION"], METADATA_DETECTION_VALUE);
  });

  it("keeps unrelated environment variables", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/usr/local/bin",
      LANG: "en_US.UTF-8",
    };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["PATH"], PATH_VALUE);
    assert.equal(env["LANG"], LANG_VALUE);
  });
});
