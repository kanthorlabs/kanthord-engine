import assert from "node:assert/strict";
import {
  deriveHandoverKeys,
  deriveSshSignKeys,
  handoverAad,
  HandoverOpenError,
  openEnvelope,
  sealEnvelope,
  type HandoverEnvelope,
} from "../kernel/handover.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { Transaction } from "../kernel/store.ts";
import { sealedObjectSchema } from "../kernel/hpke.ts";
import {
  SEALED_CIPHERTEXT_MAX_BYTES,
  SERVER_HOLDER,
  sshSignRequestSchema,
  wireReportSchema,
  type CredentialPlatforms,
  type CustodyExecution,
  type HandoverPayload,
  type HandoverSshIdentity,
  type InstanceKeys,
  type Material,
  type SshSignAnswer,
  type SshSignRequest,
  type WireReport,
} from "./contract.ts";
import {
  credentialOfSecret,
  dropExtraOAuthFields,
  secretOfCredential,
} from "./payload.ts";
import { encrypt } from "./envelope.ts";
import { openSecret, storedSealed } from "./secret.ts";

export const CUSTODY_REPORT_INVALID = "custody.handover.report_invalid";
export const CUSTODY_HOLDER_REFUSED = "custody.handover.holder_refused";
export const REVISION_REVOKED = "credential.revision.revoked";
export const SSH_SIGN_INVALID = "worker.ssh.sign_invalid";
export const SSH_SIGN_PLACEMENT_REFUSED = "worker.ssh.placement_refused";
const ONE_ROW = 1;
const NO_ITEMS = 0;
const BASE64URL = "base64url";

function invalidReport(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CUSTODY_REPORT_INVALID,
    "The credential refresh report is invalid.",
  );
}

export function plainItem(
  material: Material,
  platforms: CredentialPlatforms,
): HandoverPayload["items"][number] {
  assert(Object.hasOwn(platforms, material.platform));
  const shape = platforms[material.platform]!.secret_shape;
  assert(material.credential_id.length);
  return {
    credential_id: material.credential_id,
    provider_id: piProviderId(material.platform),
    credential: credentialOfSecret(shape, material.value()),
  };
}

export function sealMaterial(
  secret: string,
  execution: CustodyExecution,
  items: HandoverPayload["items"],
  sshIdentities: readonly HandoverSshIdentity[],
): HandoverEnvelope {
  const keys = deriveHandoverKeys(secret);
  try {
    assert(items.length > NO_ITEMS);
    const payload: HandoverPayload = {
      items,
      ssh_identities: [...sshIdentities],
    };
    return sealEnvelope(
      keys.handover,
      handoverAad(execution.execution_id, execution.runtime_identity),
      payload,
    );
  } finally {
    keys.handover.fill(0);
    keys.report.fill(0);
  }
}

export function openReport(
  secret: string,
  execution: CustodyExecution,
  envelope: HandoverEnvelope,
) {
  const keys = deriveHandoverKeys(secret);
  let value: unknown;
  try {
    value = openEnvelope(
      keys.report,
      handoverAad(execution.execution_id, execution.runtime_identity),
      envelope,
    );
  } catch (error) {
    if (error instanceof HandoverOpenError) throw invalidReport();
    throw error;
  } finally {
    keys.handover.fill(0);
    keys.report.fill(0);
  }
  const parsed = wireReportSchema.safeParse(dropExtraOAuthFields(value));
  if (
    !parsed.success ||
    !execution.credentials.includes(parsed.data.credential_id)
  )
    throw invalidReport();
  return parsed.data;
}

export function openSignRequest(
  secret: string,
  execution: CustodyExecution,
  envelope: HandoverEnvelope,
): SshSignRequest {
  const keys = deriveSshSignKeys(secret);
  let value: unknown;
  try {
    value = openEnvelope(
      keys.request,
      handoverAad(execution.execution_id, execution.runtime_identity),
      envelope,
    );
  } catch (error) {
    if (!(error instanceof HandoverOpenError)) throw error;
  } finally {
    keys.request.fill(0);
    keys.answer.fill(0);
  }
  const parsed = sshSignRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new OperationError(
      HttpStatus.BadRequest,
      SSH_SIGN_INVALID,
      "The SSH sign request is invalid.",
    );
  return parsed.data;
}

export function sealSignAnswer(
  secret: string,
  execution: CustodyExecution,
  answer: SshSignAnswer,
): HandoverEnvelope {
  const keys = deriveSshSignKeys(secret);
  try {
    return sealEnvelope(
      keys.answer,
      handoverAad(execution.execution_id, execution.runtime_identity),
      answer,
    );
  } finally {
    keys.request.fill(0);
    keys.answer.fill(0);
  }
}

type ReportedRow = {
  id: string;
  platform: string;
  holder: string;
  sealed_to: string | null;
  ended_at: number | null;
  nonce: Buffer;
  ciphertext: Buffer;
};

function writeStored(
  tx: Transaction,
  key: Buffer,
  row: ReportedRow,
  value: unknown,
): void {
  const sealed = encrypt(key, row.id, row.platform, value);
  const result = tx.database
    .prepare("UPDATE credential SET nonce = ?, ciphertext = ? WHERE id = ?")
    .run(sealed.nonce, sealed.ciphertext, row.id);
  assert.equal(result.changes, ONE_ROW);
}

function applySealedReport(
  tx: Transaction,
  key: Buffer,
  row: ReportedRow,
  report: WireReport,
  instanceKeys: InstanceKeys,
): boolean {
  if (!("sealed" in report)) throw invalidReport();
  const sealed = sealedObjectSchema.safeParse(report.sealed);
  if (
    !sealed.success ||
    Buffer.from(sealed.data.ciphertext, BASE64URL).length >
      SEALED_CIPHERTEXT_MAX_BYTES ||
    instanceKeys.keyOf(tx, row.holder)?.fingerprint !== row.sealed_to
  )
    throw invalidReport();
  if (digest(storedSealed(key, row)) !== report.digest) return false;
  writeStored(tx, key, row, sealed.data);
  return true;
}

export function applyReport(
  tx: Transaction,
  key: Buffer,
  report: WireReport,
  platforms: CredentialPlatforms,
  instanceKeys: InstanceKeys,
): boolean {
  assert(tx.database.isTransaction);
  const row = tx.database
    .prepare(
      "SELECT id, platform, holder, sealed_to, ended_at, nonce, ciphertext FROM credential WHERE id = ?",
    )
    .get(report.credential_id) as ReportedRow | undefined;
  if (!row) throw invalidReport();
  if (row.ended_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      REVISION_REVOKED,
      "The pinned credential revision is revoked.",
    );
  if (row.holder !== SERVER_HOLDER)
    return applySealedReport(tx, key, row, report, instanceKeys);
  if (!("credential" in report)) throw invalidReport();
  const shape = Object.hasOwn(platforms, row.platform)
    ? platforms[row.platform]!.secret_shape
    : undefined;
  if (shape === undefined || shape !== report.credential.type)
    throw invalidReport();
  const stored = openSecret(key, row);
  if (digest(credentialOfSecret(shape, stored)) !== report.digest) return false;
  writeStored(tx, key, row, secretOfCredential(report.credential));
  return true;
}
