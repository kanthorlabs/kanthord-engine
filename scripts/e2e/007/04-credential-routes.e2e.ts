import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { loadE2eEnv, type E2eEnv } from "../env.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import {
  killAll,
  launchDaemon,
  type DaemonProcess,
} from "../../../test/helpers/daemon.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { AesGcmCrypto } from "../../../src/services/crypto/aes-gcm.ts";
import { SystemClock } from "../../../src/services/clock/system.ts";
import { SqliteStorage } from "../../../src/services/storage/sqlite.ts";
import { migrations } from "../../../src/services/storage/migrations.ts";

type ProviderView = Readonly<{
  id: string;
  name: string;
  kind: string;
  projection: Readonly<Record<string, unknown>>;
  setDefaultAt: number | null;
  updatedAt: number;
}>;

async function request(
  url: string,
  init?: Readonly<{
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
  });
  const text = await response.text();
  const body: unknown = text === "" ? undefined : JSON.parse(text);
  return { status: response.status, body };
}

describe("scripts/e2e/007/04-credential-routes.e2e", () => {
  it("E7-04 — the credential routes serve register, list and show on a real daemon", async (t) => {
    const env: E2eEnv = loadE2eEnv();
    const tools = resolveTools();
    const home = createTemporaryHome();
    const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-e2e-keys-"));
    let daemon: DaemonProcess | undefined;
    t.after(async () => {
      if (daemon !== undefined) {
        daemon.kill();
        await daemon.exited();
      }
      rmSync(keyDirectory, { recursive: true, force: true });
      home.dispose();
      await killAll();
    });

    const configPath = home.writeConfig({
      tools: {
        git: tools.paths.git,
        ssh: tools.paths.ssh,
        sshKeyscan: tools.paths.sshKeyscan,
      },
    });
    const migrated = new SqliteStorage({
      path: join(home.path, "kanthord.db"),
      clock: new SystemClock(),
      migrations,
    });
    migrated.migrate();
    migrated.close();

    daemon = launchDaemon({ configPath, home: home.path });
    await daemon.ready();

    const baseUrl = "http://127.0.0.1:7421";
    const auth = { Authorization: "Bearer test-token" };
    const json = { ...auth, "Content-Type": "application/json" };

    const registration = await request(`${baseUrl}/v1/provider`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "e2e-github",
        kind: "git",
        payload: {
          transport: "http-basic",
          forge: "github",
          username: "x-access-token",
          token: env.ghToken,
        },
      }),
    });
    assert.equal(registration.status, 200, "the registration is accepted");
    const registered = registration.body as ProviderView;
    assert.equal(registered.kind, "git");
    assert.deepEqual(registered.projection, {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
    });
    assert.equal(JSON.stringify(registered).includes(env.ghToken), false);
    const id = registered.id;

    const listing = await request(`${baseUrl}/v1/provider`, {
      headers: auth,
    });
    const listed = listing.body as Readonly<{
      providers: readonly ProviderView[];
    }>;
    assert.equal(listed.providers.length, 1);
    assert.equal(listed.providers[0]?.id, id);
    for (const item of listed.providers) {
      assert.equal(JSON.stringify(item).includes(env.ghToken), false);
    }

    const shown = await request(`${baseUrl}/v1/provider/${id}`, {
      headers: auth,
    });
    const showView = shown.body as ProviderView;
    assert.equal(showView.id, id);
    assert.deepEqual(showView.projection, {
      transport: "http-basic",
      forge: "github",
      username: "x-access-token",
    });

    const duplicate = await request(`${baseUrl}/v1/provider`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "e2e-github",
        kind: "git",
        payload: {
          transport: "http-basic",
          forge: "github",
          username: "x-access-token",
          token: env.ghToken,
        },
      }),
    });
    assert.equal(duplicate.status, 400, "the duplicate name is refused");
    assert.equal(
      (duplicate.body as { error: { details: { refusal: string } } }).error
        .details.refusal,
      "name-taken",
    );
    const afterDuplicate = await request(`${baseUrl}/v1/provider`, {
      headers: auth,
    });
    assert.equal(
      (afterDuplicate.body as { providers: readonly unknown[] }).providers
        .length,
      1,
    );

    execFileSync(
      tools.paths.sshKeygen,
      [
        "-t",
        "ed25519",
        "-N",
        "kanthord-passphrase",
        "-f",
        join(keyDirectory, "encrypted"),
      ],
      { env: {}, encoding: "utf8" },
    );
    const encryptedKey = readFileSync(join(keyDirectory, "encrypted"), "utf8");
    const sshRefusal = await request(`${baseUrl}/v1/provider`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "e2e-ssh",
        kind: "git",
        payload: { transport: "ssh", privateKey: encryptedKey },
      }),
    });
    assert.equal(sshRefusal.status, 400, "the encrypted key is refused");
    assert.equal(
      (sshRefusal.body as { error: { details: { refusal: string } } }).error
        .details.refusal,
      "private-key-encrypted",
    );
    const afterSshRefusal = await request(`${baseUrl}/v1/provider`, {
      headers: auth,
    });
    assert.equal(
      (afterSshRefusal.body as { providers: readonly unknown[] }).providers
        .length,
      1,
    );

    daemon.kill();
    await daemon.exited();

    const db = new DatabaseSync(join(home.path, "kanthord.db"));
    const row = db
      .prepare(
        "SELECT payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE name = ?",
      )
      .get("e2e-github") as
      | Readonly<{
          payload_ciphertext: Uint8Array;
          payload_iv: Uint8Array;
          payload_tag: Uint8Array;
          key_version: number;
        }>
      | undefined;
    db.close();
    assert.ok(row !== undefined, "the e2e-github row exists");
    const ciphertext = Buffer.from(row.payload_ciphertext);
    assert.equal(
      ciphertext.toString("latin1").includes(env.ghToken),
      false,
      "the stored ciphertext hides the token",
    );
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      masterKey: string;
    };
    const crypto = new AesGcmCrypto({
      key: Buffer.from(config.masterKey, "base64"),
      keyVersion: 1,
    });
    const opened = crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
    assert.equal(opened.includes(env.ghToken), true);
  });
});
