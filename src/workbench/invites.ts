import { createHash, randomUUID } from "node:crypto";
import { HttpStatus } from "../kernel/http.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Store } from "../kernel/store.ts";
import {
  WORKBENCH_INVITE_LIFETIME_MS,
  WORKBENCH_INVITE_NAME_MAX_LENGTH,
  WORKBENCH_INVITE_PREFIX,
  WorkbenchErrorCode,
} from "./contract.ts";

const NO_CHARACTERS = 0;
const HASH_ALGORITHM = "sha256";
const HASH_ENCODING = "hex";
const NAME_SEPARATOR = "\n";

export interface InviteItem {
  id: string;
  invitee_name: string;
  expires_at: number;
}

export interface CreatedInvite extends InviteItem {
  session_id: string;
  invite_token: string;
}

export interface ResolvedInvite {
  session_id: string;
  invited_by: string;
  expires_at: number;
}

export interface JoinedInvite {
  invite_id: string;
  session_id: string;
  expires_at: number;
  guest_id: string;
  name: string;
}

interface InviteRow {
  id: string;
  session_id: string;
  invitee_name: string;
  expires_at: number;
}

function sha256Hex(text: string): string {
  return createHash(HASH_ALGORITHM).update(text).digest(HASH_ENCODING);
}

export function tokenHashOf(token: string): string {
  return sha256Hex(token);
}

export function guestIdOf(token: string, name: string): string {
  return sha256Hex(`${token}${NAME_SEPARATOR}${name}`);
}

export function inviteNameOf(name: string): string {
  const normalized = name.trim().normalize("NFC");
  if (
    normalized.length === NO_CHARACTERS ||
    normalized.length > WORKBENCH_INVITE_NAME_MAX_LENGTH
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkbenchErrorCode.InviteNameInvalid,
      "The name holds 1 to 64 characters and is not blank.",
    );
  return normalized;
}

export class WorkbenchInvites {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  create(
    sessionId: string,
    invitedBy: string,
    inviteeName: string,
  ): CreatedInvite {
    const name = inviteNameOf(inviteeName);
    const token = randomUUID();
    const id = createIdentity(WORKBENCH_INVITE_PREFIX);
    const now = Date.now();
    const expiresAt = now + WORKBENCH_INVITE_LIFETIME_MS;
    this.store.transaction((tx) => {
      tx.database
        .prepare(
          "DELETE FROM workbench_invite WHERE session_id = ? AND expires_at <= ?",
        )
        .run(sessionId, now);
      tx.database
        .prepare(
          "INSERT INTO workbench_invite (id, session_id, token_hash, invited_by, expires_at, invitee_name) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, sessionId, tokenHashOf(token), invitedBy, expiresAt, name);
    });
    return {
      id,
      session_id: sessionId,
      invitee_name: name,
      expires_at: expiresAt,
      invite_token: token,
    };
  }

  join(token: string, name: string): JoinedInvite | null {
    const guestName = inviteNameOf(name);
    const row = this.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT id, session_id, invitee_name, expires_at FROM workbench_invite WHERE token_hash = ? AND expires_at > ?",
          )
          .get(tokenHashOf(token), Date.now()) as InviteRow | undefined,
    );
    if (row === undefined) return null;
    return {
      invite_id: row.id,
      session_id: row.session_id,
      expires_at: row.expires_at,
      guest_id: guestIdOf(token, guestName),
      name: guestName,
    };
  }

  resolve(inviteId: string): ResolvedInvite | null {
    const row = this.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT session_id, invited_by, expires_at FROM workbench_invite WHERE id = ? AND expires_at > ?",
          )
          .get(inviteId, Date.now()) as ResolvedInvite | undefined,
    );
    return row === undefined ? null : { ...row };
  }

  list(sessionId: string): InviteItem[] {
    return this.store
      .transaction((tx) =>
        tx.database
          .prepare(
            "SELECT id, invitee_name, expires_at FROM workbench_invite WHERE session_id = ? AND expires_at > ? ORDER BY expires_at, id",
          )
          .all(sessionId, Date.now()),
      )
      .map((row) => ({ ...(row as unknown as InviteItem) }));
  }

  revoke(inviteId: string): InviteRow | null {
    const row = this.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "DELETE FROM workbench_invite WHERE id = ? RETURNING id, session_id, invitee_name, expires_at",
          )
          .get(inviteId) as InviteRow | undefined,
    );
    return row === undefined ? null : { ...row };
  }

  isShared(sessionId: string): boolean {
    return (
      this.store.transaction(
        (tx) =>
          tx.database
            .prepare(
              "SELECT 1 AS shared FROM workbench_invite WHERE session_id = ? AND expires_at > ? LIMIT 1",
            )
            .get(sessionId, Date.now()) as { shared: number } | undefined,
      ) !== undefined
    );
  }
}
