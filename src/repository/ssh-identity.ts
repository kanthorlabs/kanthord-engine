import { z } from "zod";
import { HttpStatus } from "../kernel/http.ts";
import { OperationError } from "../kernel/errors.ts";
import type { SshIdentity } from "../project/contract.ts";

export type { SshIdentity };

export const SshErrorCode = {
  IdentityAmbiguous: "repository.credential.ssh_identity_ambiguous",
  Drift: "repository.credential.ssh_drift",
  ConfigUnreadable: "repository.credential.ssh_config_unreadable",
  ResolveFailed: "repository.credential.ssh_resolve_failed",
} as const;

export const sshPinSchema = z.strictObject({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  hostname: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  identity_file: z.string().min(1),
});
export type SshPin = z.infer<typeof sshPinSchema>;

const DECIMAL = 10;
const IDENTITIES_ONLY_YES = "yes";
const SINGLE_IDENTITY = 1;
const NO_DRIFT = 0;
const PATTERN_CHARACTERS = /[*?!]/;
const NO_NAME = "";

function valuesOf(output: string, keyword: string): string[] {
  const prefix = `${keyword} `;
  return output
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

export function parseSshIdentity(output: string): SshIdentity {
  const [hostname] = valuesOf(output, "hostname");
  const [port] = valuesOf(output, "port");
  const [identitiesOnly] = valuesOf(output, "identitiesonly");
  if (!hostname || !port) throw new Error("ssh -G: incomplete output.");
  return {
    hostname,
    port: Number.parseInt(port, DECIMAL),
    identityFiles: valuesOf(output, "identityfile"),
    identitiesOnly: identitiesOnly === IDENTITIES_ONLY_YES,
  };
}

export function ambiguityOf(identity: SshIdentity): string | null {
  if (!identity.identitiesOnly) return "identitiesonly";
  if (identity.identityFiles.length !== SINGLE_IDENTITY) return "identityfile";
  return null;
}

export function pinOf(host: string, identity: SshIdentity): SshPin {
  const ambiguous = ambiguityOf(identity);
  if (ambiguous !== null)
    throw new OperationError(
      HttpStatus.BadRequest,
      SshErrorCode.IdentityAmbiguous,
      "The SSH host must resolve with identitiesonly yes and exactly one identityfile.",
      { host, key: ambiguous },
    );
  return {
    host,
    hostname: identity.hostname,
    port: identity.port,
    identity_file: identity.identityFiles[0]!,
  };
}

export function assertPinned(pin: SshPin, identity: SshIdentity): void {
  const resolved = pinOf(pin.host, identity);
  const keys = (["hostname", "port", "identity_file"] as const).filter(
    (key) => resolved[key] !== pin[key],
  );
  if (keys.length !== NO_DRIFT)
    throw new OperationError(
      HttpStatus.BadRequest,
      SshErrorCode.Drift,
      "The SSH host resolves to values that differ from the SSH credential.",
      { host: pin.host, keys },
    );
}

export function configHosts(text: string): string[] {
  const hosts = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .map((line) => /^host(?:\s*=\s*|\s+)(.+)$/i.exec(line)?.[1] ?? "")
    .flatMap((names) => names.split(/\s+/))
    .filter((name) => name !== NO_NAME && !PATTERN_CHARACTERS.test(name))
    .filter((name) => sshPinSchema.shape.host.safeParse(name).success);
  return [...new Set(hosts)];
}
