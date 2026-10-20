import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { sshKeyRevision } from "./credential.ts";
import { SshSignErrorCode, SshSignRefusal } from "./contract.ts";
import { generateSshKey, sshPublicKeyBlob } from "./ssh-key.ts";
import {
  relayedSignature,
  signRefusalOf,
  SshAuthenticationMethod,
} from "./ssh-sign.ts";
import {
  knownHostsKeyBlob,
  sshSignatureVerifies,
  userAuthenticationData,
} from "./test-sshd.ts";

const HOST_KEY_LINE =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const PORT = 22;
const OTHER_USER = "root";
const NO_SIGNATURE = 0;
const PASSWORD_METHOD = "password";
const RSA_ALGORITHM = "rsa-sha2-256";
const OTHER_SERVICE = "ssh-userauth";
const TRAILING = Buffer.from([1]);
const OPENSSH_ED25519 = /^ssh-ed25519 /;

function fixture() {
  const key = generateSshKey("deploy");
  return {
    key,
    access: {
      private_key: key.private_key,
      public_key: key.public_key,
      known_hosts: HOST_KEY_LINE,
      port: PORT,
    },
    blob: sshPublicKeyBlob(key.public_key),
    hostKey: knownHostsKeyBlob(HOST_KEY_LINE),
  };
}

test("the relay signs a publickey and a host-bound request of the record key with ed25519", () => {
  const f = fixture();
  for (const hostKey of [null, f.hostKey]) {
    const data = userAuthenticationData({ key: f.blob, hostKey });
    assert.equal(signRefusalOf(f.access, data), null);
    const signature = relayedSignature(f.access, data);
    assert.ok(sshSignatureVerifies(f.key.public_key, data, signature));
    assert.equal(
      sshSignatureVerifies(generateSshKey("other").public_key, data, signature),
      false,
    );
  }
});

test("the repository key type is ed25519 for every generated SSH record", () => {
  const revision = sshKeyRevision("deploy");
  assert.match(String(revision.metadata.public_key), OPENSSH_ED25519);
});

test("a payload that is no user authentication answers not_user_authentication", () => {
  const f = fixture();
  const payloads = [
    Buffer.from("not an SSH payload"),
    Buffer.alloc(0),
    userAuthenticationData({ key: f.blob, user: OTHER_USER }),
    userAuthenticationData({ key: f.blob, service: OTHER_SERVICE }),
    userAuthenticationData({ key: f.blob, method: PASSWORD_METHOD }),
    userAuthenticationData({ key: f.blob, signature: NO_SIGNATURE }),
    userAuthenticationData({ key: f.blob, trailing: TRAILING }),
    userAuthenticationData({
      key: f.blob,
      hostKey: f.hostKey,
      method: SshAuthenticationMethod.PublicKey,
    }),
  ];
  for (const data of payloads)
    assert.equal(
      signRefusalOf(f.access, data),
      SshSignRefusal.NotUserAuthentication,
    );
});

test("another key or another algorithm answers key_mismatch", () => {
  const f = fixture();
  const other = sshPublicKeyBlob(generateSshKey("other").public_key);
  assert.equal(
    signRefusalOf(f.access, userAuthenticationData({ key: other })),
    SshSignRefusal.KeyMismatch,
  );
  assert.equal(
    signRefusalOf(
      f.access,
      userAuthenticationData({ key: f.blob, algorithm: RSA_ALGORITHM }),
    ),
    SshSignRefusal.KeyMismatch,
  );
});

test("a host-bound request for another host key answers host_key_mismatch", () => {
  const f = fixture();
  const otherHost = sshPublicKeyBlob(generateSshKey("host").public_key);
  assert.equal(
    signRefusalOf(
      f.access,
      userAuthenticationData({ key: f.blob, hostKey: otherHost }),
    ),
    SshSignRefusal.HostKeyMismatch,
  );
});

test("a refused payload throws sign_refused with its reason and no signature", () => {
  const f = fixture();
  assert.throws(
    () =>
      relayedSignature(
        f.access,
        userAuthenticationData({ key: f.blob, user: OTHER_USER }),
      ),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, SshSignErrorCode.Refused);
      assert.deepEqual(error.details, {
        reason: SshSignRefusal.NotUserAuthentication,
      });
      return true;
    },
  );
});
