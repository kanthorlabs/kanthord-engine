import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  SSH_SIGN_USER,
  type SshKeyAccess,
  SshSignErrorCode,
  SshSignRefusal,
} from "./contract.ts";
import {
  SSH_KEY_TYPE,
  sshPublicKeyBlob,
  SshReader,
  sshSignatureOf,
} from "./ssh-key.ts";

export const SSH_USERAUTH_REQUEST = 50;
export const SSH_CONNECTION_SERVICE = "ssh-connection";
export const SshAuthenticationMethod = {
  PublicKey: "publickey",
  HostBound: "publickey-hostbound-v00@openssh.com",
} as const;
type SshAuthenticationMethod =
  (typeof SshAuthenticationMethod)[keyof typeof SshAuthenticationMethod];

const HAS_SIGNATURE = 1;
const NO_BYTES = 0;
const LINE_END = "\n";
const FIELD_SEPARATOR = /\s+/;
const KNOWN_HOSTS_KEY_FIELD = 2;
const METHODS: readonly string[] = Object.values(SshAuthenticationMethod);

interface UserAuthentication {
  user: string;
  method: SshAuthenticationMethod;
  algorithm: string;
  key: Buffer;
  hostKey: Buffer | null;
}

function userAuthenticationOf(data: Buffer): UserAuthentication | null {
  try {
    const reader = new SshReader(data);
    if (reader.bytes().length === NO_BYTES) return null;
    if (reader.byte() !== SSH_USERAUTH_REQUEST) return null;
    const user = reader.text();
    if (reader.text() !== SSH_CONNECTION_SERVICE) return null;
    const method = reader.text();
    if (!METHODS.includes(method)) return null;
    if (reader.byte() !== HAS_SIGNATURE) return null;
    const algorithm = reader.text();
    const key = reader.bytes();
    const hostKey =
      method === SshAuthenticationMethod.HostBound ? reader.bytes() : null;
    if (reader.rest().length !== NO_BYTES) return null;
    return {
      user,
      method: method as SshAuthenticationMethod,
      algorithm,
      key,
      hostKey,
    };
  } catch {
    return null;
  }
}

function pinnedHostKeys(knownHosts: string): Buffer[] {
  return knownHosts
    .split(LINE_END)
    .map((line) => line.trim().split(FIELD_SEPARATOR)[KNOWN_HOSTS_KEY_FIELD])
    .filter((key): key is string => key !== undefined && key.length > NO_BYTES)
    .map((key) => Buffer.from(key, "base64"));
}

export function signRefusalOf(
  access: Pick<SshKeyAccess, "public_key" | "known_hosts">,
  data: Buffer,
  user = SSH_SIGN_USER,
): SshSignRefusal | null {
  const authentication = userAuthenticationOf(data);
  if (authentication === null || authentication.user !== user)
    return SshSignRefusal.NotUserAuthentication;
  if (
    authentication.algorithm !== SSH_KEY_TYPE ||
    !authentication.key.equals(sshPublicKeyBlob(access.public_key))
  )
    return SshSignRefusal.KeyMismatch;
  const hostKey = authentication.hostKey;
  if (
    hostKey !== null &&
    !pinnedHostKeys(access.known_hosts).some((pinned) => pinned.equals(hostKey))
  )
    return SshSignRefusal.HostKeyMismatch;
  return null;
}

export function refuseSignPayload(
  access: Pick<SshKeyAccess, "public_key" | "known_hosts">,
  data: Buffer,
  user = SSH_SIGN_USER,
): void {
  const reason = signRefusalOf(access, data, user);
  if (reason !== null)
    throw new OperationError(
      HttpStatus.BadRequest,
      SshSignErrorCode.Refused,
      "The SSH signature relay refuses the payload.",
      { reason },
    );
}

export function relayedSignature(
  access: SshKeyAccess,
  data: Buffer,
  user = SSH_SIGN_USER,
): Buffer {
  refuseSignPayload(access, data, user);
  return sshSignatureOf(access.private_key, data);
}
