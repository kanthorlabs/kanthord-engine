import assert from "node:assert/strict";
import {
  deriveHandoverKeys,
  handoverAad,
  HandoverOpenError,
  openEnvelope,
  sealEnvelope,
  type HandoverEnvelope,
} from "../kernel/handover.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  refreshReportSchema,
  type CustodyExecution,
  type Material,
} from "./contract.ts";
import {
  credentialOfSecret,
  dropExtraOAuthFields,
  secretOfCredential,
} from "./payload.ts";
import { PLATFORM_VALIDATORS, type Platform } from "./platforms.ts";
import { decrypt, encrypt } from "./envelope.ts";

export const CUSTODY_REPORT_INVALID = "custody.handover.report_invalid";
export const REVISION_REVOKED = "credential.revision.revoked";
const ONE_ROW = 1;

function invalidReport(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CUSTODY_REPORT_INVALID,
    "The credential refresh report is invalid.",
  );
}

export function sealMaterial(
  secret: string,
  execution: CustodyExecution,
  material: Material,
): HandoverEnvelope {
  const keys = deriveHandoverKeys(secret);
  try {
    const shape =
      PLATFORM_VALIDATORS[material.platform as Platform]?.secretShape;
    assert(shape);
    assert(material.credentialId.length);
    const payload = {
      items: [
        {
          credentialId: material.credentialId,
          providerId: material.platform,
          credential: credentialOfSecret(shape, material.value()),
        },
      ],
    };
    return sealEnvelope(
      keys.handover,
      handoverAad(execution.executionId, execution.runtimeIdentity),
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
      handoverAad(execution.executionId, execution.runtimeIdentity),
      envelope,
    );
  } catch (error) {
    if (error instanceof HandoverOpenError) throw invalidReport();
    throw error;
  } finally {
    keys.handover.fill(0);
    keys.report.fill(0);
  }
  const parsed = refreshReportSchema.safeParse(dropExtraOAuthFields(value));
  if (
    !parsed.success ||
    !execution.credentials.includes(parsed.data.credentialId)
  )
    throw invalidReport();
  return parsed.data;
}

export function applyReport(
  tx: Transaction,
  key: Buffer,
  report: ReturnType<typeof openReport>,
): boolean {
  assert(tx.database.isTransaction);
  const row = tx.database
    .prepare(
      "SELECT id, platform, ended_at, nonce, ciphertext FROM credential WHERE id = ?",
    )
    .get(report.credentialId) as
    | {
        id: string;
        platform: Platform;
        ended_at: number | null;
        nonce: Buffer;
        ciphertext: Buffer;
      }
    | undefined;
  if (!row) throw invalidReport();
  if (row.ended_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      REVISION_REVOKED,
      "The pinned credential revision is revoked.",
    );
  const shape = PLATFORM_VALIDATORS[row.platform].secretShape;
  if (shape !== report.credential.type) throw invalidReport();
  const stored = decrypt(key, row.id, row.platform, row.nonce, row.ciphertext);
  if (digest(credentialOfSecret(shape, stored)) !== report.digest) return false;
  const sealed = encrypt(
    key,
    row.id,
    row.platform,
    secretOfCredential(report.credential),
  );
  const result = tx.database
    .prepare("UPDATE credential SET nonce = ?, ciphertext = ? WHERE id = ?")
    .run(sealed.nonce, sealed.ciphertext, row.id);
  assert.equal(result.changes, ONE_ROW);
  return true;
}
