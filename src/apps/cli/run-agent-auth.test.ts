import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  checkAuthEntry,
  checkAuthExpiry,
  checkAuthFile,
  defaultAuthPath,
  readAuthEntry,
} from "./run-agent-auth.ts";

const AUTH_FILE_INVALID = "cli.run.agent.auth_file_invalid";
const AUTH_FILE_MODE = "cli.run.agent.auth_file_mode";
const AUTH_PLACE = "cli.run.agent.auth_place";
const AUTH_ENTRY_MISSING = "cli.run.agent.auth_entry_missing";
const AUTH_ENTRY_INVALID = "cli.run.agent.auth_entry_invalid";
const AUTH_KEY_COMMAND = "cli.run.agent.auth_key_command";
const AUTH_KEY_REFERENCE = "cli.run.agent.auth_key_reference";
const CREDENTIAL_EXPIRING = "cli.run.agent.credential_expiring";
const FIELD_PATH = "path";
const FIELD_FIELD = "field";
const FIELD_KEY = "key";
const FIELD_TYPE = "type";
const ENV_BASE_URL = "env.OPENAI_COMPATIBLE_BASE_URL";
const ENV_MODELS = "env.OPENAI_COMPATIBLE_MODELS";
const ENV_AWS_REGION = "env.AWS_REGION";
const ENV_GOOGLE_PROJECT = "env.GOOGLE_CLOUD_PROJECT";
const ENV_GOOGLE_LOCATION = "env.GOOGLE_CLOUD_LOCATION";
const ENV_SOME_VAR = "env.SOME_VAR";
const ENV_AAAA_EXTRA = "env.AAAA_EXTRA";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENAI_PROVIDER = "openai";
const OPENAI_COMPAT_PROVIDER = "openai-compatible";
const AMAZON_BEDROCK_PROVIDER = "amazon-bedrock";
const GOOGLE_VERTEX_PROVIDER = "google-vertex";
const AZURE_PROVIDER = "azure";
const CF_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
const CF_AI_GATEWAY_PROVIDER = "cloudflare-ai-gateway";
const WINDOW = 300_000;
const ROOT_UID = 0;

let base: string;

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-auth-test-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function workspace(): string {
  const dir = join(base, `w-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function writeAuthJson(
  dir: string,
  name: string,
  content: unknown = {},
): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
  return path;
}

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

describe("defaultAuthPath", () => {
  it("ends with .config/kanthord/auth.json", () => {
    const p = defaultAuthPath();
    assert.ok(p.endsWith(join(".config", "kanthord", "auth.json")));
  });

  it("starts with the user database home directory", () => {
    const p = defaultAuthPath();
    assert.ok(p.startsWith(userInfo().homedir));
  });

  it("is not affected by HOME env var", () => {
    const dbHome = userInfo().homedir;
    const p = defaultAuthPath();
    assert.ok(p.startsWith(dbHome));
  });
});

describe("checkAuthFile", () => {
  it("passes for a valid file", () => {
    const w = workspace();
    const path = writeAuthJson(base, `valid-${Date.now()}.json`);
    assert.doesNotThrow(() => checkAuthFile(path, w));
  });

  it("refuses an absent path", () => {
    const w = workspace();
    const path = join(base, `absent-${Date.now()}.json`);
    const error = assertDiagnostic(
      () => checkAuthFile(path, w),
      AUTH_FILE_INVALID,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_PATH));
  });

  it("refuses a symbolic link", () => {
    const w = workspace();
    const target = writeAuthJson(base, `target-${Date.now()}.json`);
    const link = join(base, `link-${Date.now()}.json`);
    symlinkSync(target, link);
    assertDiagnostic(() => checkAuthFile(link, w), AUTH_FILE_INVALID);
  });

  it("refuses mode 0640", () => {
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    const w = workspace();
    const path = writeAuthJson(base, `mode640-${Date.now()}.json`);
    chmodSync(path, 0o640);
    assertDiagnostic(() => checkAuthFile(path, w), AUTH_FILE_MODE);
  });

  it("refuses mode 0604", () => {
    const uid = userInfo().uid;
    if (uid === ROOT_UID) return;
    const w = workspace();
    const path = writeAuthJson(base, `mode604-${Date.now()}.json`);
    chmodSync(path, 0o604);
    assertDiagnostic(() => checkAuthFile(path, w), AUTH_FILE_MODE);
  });

  it("refuses a file inside the workspace", () => {
    const w = workspace();
    const path = writeAuthJson(w, `in-workspace-${Date.now()}.json`);
    assertDiagnostic(() => checkAuthFile(path, w), AUTH_PLACE);
  });
});

describe("readAuthEntry", () => {
  it("returns the raw entry for a present provider", () => {
    const path = writeAuthJson(base, `present-${Date.now()}.json`, {
      anthropic: { type: "api_key", key: "fixture-test-api-key" },
    });
    const result = readAuthEntry(ANTHROPIC_PROVIDER, path);
    assert.ok(result !== undefined);
  });

  it("refuses when the provider entry is absent", () => {
    const path = writeAuthJson(base, `no-entry-${Date.now()}.json`, {
      "other-provider": { type: "api_key", key: "fixture-other-key" },
    });
    const error = assertDiagnostic(
      () => readAuthEntry(ANTHROPIC_PROVIDER, path),
      AUTH_ENTRY_MISSING,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_FIELD));
  });

  it("refuses when the file holds no valid JSON", () => {
    const path = join(base, `invalid-json-${Date.now()}.json`);
    writeFileSync(path, "not-json", { mode: 0o600 });
    assertDiagnostic(
      () => readAuthEntry(ANTHROPIC_PROVIDER, path),
      AUTH_ENTRY_MISSING,
    );
  });
});

describe("checkAuthEntry - schema", () => {
  const authPath = "/fixture/auth.json";

  it("passes a valid api_key entry", () => {
    const raw = { type: "api_key", key: "fixture-valid-api-key" };
    assert.doesNotThrow(() =>
      checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
    );
  });

  it("passes a valid oauth entry", () => {
    const raw = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3_600_000,
    };
    assert.doesNotThrow(() =>
      checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
    );
  });

  it("refuses an unknown type", () => {
    const raw = { type: "unknown", key: "fixture-key" };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_FIELD));
  });

  it("refuses an api_key entry with no key", () => {
    const raw = { type: "api_key" };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    const fieldRow = error.fields.find(([k]) => k === FIELD_FIELD);
    assert.equal(fieldRow?.[1], FIELD_KEY);
  });

  it("refuses an oauth entry missing access", () => {
    const raw = {
      type: "oauth",
      refresh: "fixture-refresh",
      expires: Date.now() + 3_600_000,
    };
    assertDiagnostic(
      () => checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
  });
});

describe("checkAuthEntry - shell command key", () => {
  const authPath = "/fixture/auth.json";

  it("refuses a key that starts with !", () => {
    const raw = { type: "api_key", key: "!fixture-command" };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
      AUTH_KEY_COMMAND,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === FIELD_KEY),
    );
  });
});

describe("checkAuthEntry - variable reference key", () => {
  const authPath = "/fixture/auth.json";

  for (const keyValue of [
    "$NAME",
    "${NAME}",
    "prefix-$NAME",
    "prefix-${NAME}",
    "$$",
    "$!",
  ]) {
    it(`refuses a key that contains $ (${keyValue})`, () => {
      const raw = { type: "api_key", key: keyValue };
      const error = assertDiagnostic(
        () => checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath),
        AUTH_KEY_REFERENCE,
      );
      assert.ok(
        error.fields.some(([k, v]) => k === FIELD_FIELD && v === FIELD_KEY),
      );
    });
  }
});

describe("checkAuthEntry - provider check", () => {
  const authPath = "/fixture/auth.json";

  it("accepts anthropic with api_key → engine provider anthropic", () => {
    const raw = { type: "api_key", key: "fixture-api-key" };
    const result = checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath);
    assert.ok(result.metadata === null);
  });

  it("accepts anthropic with oauth → engine provider anthropic-subscription", () => {
    const raw = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3_600_000,
    };
    const result = checkAuthEntry(raw, ANTHROPIC_PROVIDER, authPath);
    assert.ok(result.metadata === null);
  });

  it("refuses openai with oauth entry", () => {
    const raw = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3_600_000,
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === FIELD_TYPE),
    );
  });
});

describe("checkAuthEntry - routing metadata", () => {
  const authPath = "/fixture/auth.json";
  const BASE_URL_VALUE = "http://127.0.0.1:8080/v1";
  const REGION_VALUE = "us-east-1";
  const PROJECT_VALUE = "my-project";
  const LOCATION_VALUE = "us-central1";
  const RESOURCE_VALUE = "my-resource";
  const ACCOUNT_ID_VALUE = "acct-id";
  const GATEWAY_ID_VALUE = "gw-id";
  const META_BASE_URL = "base_url";
  const META_MODELS = "models";
  const META_REGION = "region";
  const META_PROJECT = "project";
  const META_LOCATION = "location";
  const META_RESOURCE_NAME = "resource_name";
  const META_ACCOUNT_ID = "account_id";
  const META_GATEWAY_ID = "gateway_id";

  it("passes openai-compatible with valid env", () => {
    const raw = {
      type: "api_key",
      key: "fixture-compat-key",
      env: {
        OPENAI_COMPATIBLE_BASE_URL: BASE_URL_VALUE,
        OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: "stub-1" }]),
      },
    };
    const result = checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath);
    assert.ok(result.metadata !== null);
    assert.equal(result.metadata[META_BASE_URL], BASE_URL_VALUE);
    assert.ok(Array.isArray(result.metadata[META_MODELS]));
  });

  it("reports OPENAI_COMPATIBLE_BASE_URL first when both names are absent (table order)", () => {
    const raw = { type: "api_key", key: "fixture-key", env: {} };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_BASE_URL),
    );
  });

  it("reports OPENAI_COMPATIBLE_MODELS when BASE_URL is present but MODELS is absent", () => {
    const raw = {
      type: "api_key",
      key: "fixture-key",
      env: { OPENAI_COMPATIBLE_BASE_URL: BASE_URL_VALUE },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_MODELS),
    );
  });

  it("refuses an invalid BASE_URL", () => {
    const raw = {
      type: "api_key",
      key: "fixture-key",
      env: {
        OPENAI_COMPATIBLE_BASE_URL: "not-a-url",
        OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: "stub-1" }]),
      },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_BASE_URL),
    );
  });

  it("refuses invalid JSON for OPENAI_COMPATIBLE_MODELS", () => {
    const raw = {
      type: "api_key",
      key: "fixture-key",
      env: {
        OPENAI_COMPATIBLE_BASE_URL: BASE_URL_VALUE,
        OPENAI_COMPATIBLE_MODELS: "not-json",
      },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_MODELS),
    );
  });

  it("refuses an extra env name (byte order: A before Z)", () => {
    const raw = {
      type: "api_key",
      key: "fixture-key",
      env: {
        OPENAI_COMPATIBLE_BASE_URL: BASE_URL_VALUE,
        OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: "stub-1" }]),
        AAAA_EXTRA: "value",
        ZZZZ_EXTRA: "value",
      },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_COMPAT_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_AAAA_EXTRA),
    );
  });

  it("passes amazon-bedrock with AWS_REGION", () => {
    const raw = {
      type: "api_key",
      key: "fixture-bedrock-key",
      env: { AWS_REGION: REGION_VALUE },
    };
    const result = checkAuthEntry(raw, AMAZON_BEDROCK_PROVIDER, authPath);
    assert.equal(result.metadata?.[META_REGION], REGION_VALUE);
  });

  it("refuses amazon-bedrock with absent AWS_REGION", () => {
    const raw = { type: "api_key", key: "fixture-bedrock-key", env: {} };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, AMAZON_BEDROCK_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_AWS_REGION),
    );
  });

  it("passes google-vertex with both env names", () => {
    const raw = {
      type: "api_key",
      key: "fixture-vertex-key",
      env: {
        GOOGLE_CLOUD_PROJECT: PROJECT_VALUE,
        GOOGLE_CLOUD_LOCATION: LOCATION_VALUE,
      },
    };
    const result = checkAuthEntry(raw, GOOGLE_VERTEX_PROVIDER, authPath);
    assert.equal(result.metadata?.[META_PROJECT], PROJECT_VALUE);
    assert.equal(result.metadata?.[META_LOCATION], LOCATION_VALUE);
  });

  it("reports GOOGLE_CLOUD_PROJECT first for google-vertex when both are absent", () => {
    const raw = { type: "api_key", key: "fixture-vertex-key", env: {} };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, GOOGLE_VERTEX_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(
        ([k, v]) => k === FIELD_FIELD && v === ENV_GOOGLE_PROJECT,
      ),
    );
  });

  it("reports GOOGLE_CLOUD_LOCATION when project is present but location is absent", () => {
    const raw = {
      type: "api_key",
      key: "fixture-vertex-key",
      env: { GOOGLE_CLOUD_PROJECT: PROJECT_VALUE },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, GOOGLE_VERTEX_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(
        ([k, v]) => k === FIELD_FIELD && v === ENV_GOOGLE_LOCATION,
      ),
    );
  });

  it("passes azure with AZURE_OPENAI_RESOURCE_NAME", () => {
    const raw = {
      type: "api_key",
      key: "fixture-azure-key",
      env: { AZURE_OPENAI_RESOURCE_NAME: RESOURCE_VALUE },
    };
    const result = checkAuthEntry(raw, AZURE_PROVIDER, authPath);
    assert.equal(result.metadata?.[META_RESOURCE_NAME], RESOURCE_VALUE);
  });

  it("passes cloudflare-workers-ai with CLOUDFLARE_ACCOUNT_ID", () => {
    const raw = {
      type: "api_key",
      key: "fixture-cf-key",
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_VALUE },
    };
    const result = checkAuthEntry(raw, CF_WORKERS_AI_PROVIDER, authPath);
    assert.equal(result.metadata?.[META_ACCOUNT_ID], ACCOUNT_ID_VALUE);
  });

  it("passes cloudflare-ai-gateway with both env names", () => {
    const raw = {
      type: "api_key",
      key: "fixture-cfg-key",
      env: {
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_VALUE,
        CLOUDFLARE_GATEWAY_ID: GATEWAY_ID_VALUE,
      },
    };
    const result = checkAuthEntry(raw, CF_AI_GATEWAY_PROVIDER, authPath);
    assert.equal(result.metadata?.[META_ACCOUNT_ID], ACCOUNT_ID_VALUE);
    assert.equal(result.metadata?.[META_GATEWAY_ID], GATEWAY_ID_VALUE);
  });

  it("refuses env on a provider with no metadata mapping", () => {
    const raw = {
      type: "api_key",
      key: "fixture-key",
      env: { SOME_VAR: "value" },
    };
    const error = assertDiagnostic(
      () => checkAuthEntry(raw, OPENAI_PROVIDER, authPath),
      AUTH_ENTRY_INVALID,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_FIELD && v === ENV_SOME_VAR),
    );
  });

  it("passes absent env on a provider with no metadata mapping", () => {
    const raw = { type: "api_key", key: "fixture-key" };
    const result = checkAuthEntry(raw, OPENAI_PROVIDER, authPath);
    assert.equal(result.metadata, null);
  });
});

describe("checkAuthExpiry", () => {
  const authPath = "/fixture/auth.json";

  it("passes an api_key credential with no expiry check", () => {
    const credential = { type: "api_key" as const, key: "fixture-key" };
    assert.doesNotThrow(() =>
      checkAuthExpiry(credential, Date.now() + 3_600_000, authPath),
    );
  });

  it("passes an oauth credential that expires well after the deadline plus window", () => {
    const wallDeadlineMs = Date.now() + 60_000;
    const expires = wallDeadlineMs + WINDOW + 60_000;
    const credential = {
      type: "oauth" as const,
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires,
    };
    assert.doesNotThrow(() =>
      checkAuthExpiry(credential, wallDeadlineMs, authPath),
    );
  });

  it("refuses an oauth credential that expires before the deadline plus window", () => {
    const wallDeadlineMs = Date.now() + 60_000;
    const expires = wallDeadlineMs + WINDOW - 1;
    const credential = {
      type: "oauth" as const,
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires,
    };
    const error = assertDiagnostic(
      () => checkAuthExpiry(credential, wallDeadlineMs, authPath),
      CREDENTIAL_EXPIRING,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_PATH));
  });

  it("passes an oauth credential that expires exactly at the deadline plus window", () => {
    const wallDeadlineMs = Date.now() + 60_000;
    const expires = wallDeadlineMs + WINDOW;
    const credential = {
      type: "oauth" as const,
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires,
    };
    assert.doesNotThrow(() =>
      checkAuthExpiry(credential, wallDeadlineMs, authPath),
    );
  });

  it("refuses an already-expired oauth credential", () => {
    const wallDeadlineMs = Date.now() + 60_000;
    const expires = Date.now() - 1;
    const credential = {
      type: "oauth" as const,
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires,
    };
    assertDiagnostic(
      () => checkAuthExpiry(credential, wallDeadlineMs, authPath),
      CREDENTIAL_EXPIRING,
    );
  });
});
