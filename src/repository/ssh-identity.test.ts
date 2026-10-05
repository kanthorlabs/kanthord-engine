import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import {
  assertPinned,
  configHosts,
  parseSshIdentity,
  pinOf,
  SshErrorCode,
} from "./ssh-identity.ts";

const OUTPUT = [
  "user kanthorlabs",
  "hostname ssh.github.com",
  "port 443",
  "identitiesonly yes",
  "identityfile ~/.ssh/id_kanthorlabs",
  "",
].join("\n");
const PIN = {
  host: "kanthorlabs.github.com",
  hostname: "ssh.github.com",
  port: 443,
  identity_file: "~/.ssh/id_kanthorlabs",
};

function refusesWith(fn: () => unknown, code: string) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseSshIdentity reads hostname, port, identity files and identitiesonly", () => {
  assert.deepEqual(parseSshIdentity(OUTPUT), {
    hostname: "ssh.github.com",
    port: 443,
    identityFiles: ["~/.ssh/id_kanthorlabs"],
    identitiesOnly: true,
  });
  assert.throws(() => parseSshIdentity("user git\n"));
});

test("pinOf requires identitiesonly yes and exactly one identity file", () => {
  const identity = parseSshIdentity(OUTPUT);
  assert.deepEqual(pinOf(PIN.host, identity), PIN);
  refusesWith(
    () => pinOf(PIN.host, { ...identity, identitiesOnly: false }),
    SshErrorCode.IdentityAmbiguous,
  );
  refusesWith(
    () => pinOf(PIN.host, { ...identity, identityFiles: [] }),
    SshErrorCode.IdentityAmbiguous,
  );
});

test("assertPinned names every drifted key", () => {
  const identity = parseSshIdentity(OUTPUT);
  assertPinned(PIN, identity);
  assert.throws(
    () => assertPinned(PIN, { ...identity, port: 22 }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, SshErrorCode.Drift);
      assert.deepEqual(error.details, { host: PIN.host, keys: ["port"] });
      return true;
    },
  );
});

test("configHosts keeps concrete aliases once and skips patterns and comments", () => {
  assert.deepEqual(
    configHosts(
      [
        "Host *",
        "host github.com # personal",
        "  IdentityFile ~/.ssh/id_ed25519",
        "Host=kanthorlabs.github.com other.github.com",
        "Host !negated wild?.github.com",
        "Host github.com",
        "Match host foo",
        "Hostname ssh.github.com",
      ].join("\n"),
    ),
    ["github.com", "kanthorlabs.github.com", "other.github.com"],
  );
});
