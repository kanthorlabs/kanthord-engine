import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpStatus } from "../kernel/http.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import type { Store } from "../kernel/store.ts";
import {
  type ResolvedInvite,
  WORKBENCH_INVITE_LIFETIME_MS,
  WORKBENCH_INVITE_NAME_MAX_LENGTH,
  WORKBENCH_INVITE_PREFIX,
  WORKBENCH_INVITE_PROJECT_LIMIT,
  WorkbenchErrorCode,
} from "./contract.ts";
import { grantableOperations } from "./guard.ts";

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
  granted_operations: string[];
  invite_token: string;
}

export interface Inviter {
  accountId: string;
  name: string;
}

export interface LiveInviteItem extends InviteItem {
  project_ids: string[];
  granted_operations: string[];
}

export interface InviteRequest {
  name: string;
  projectIds: readonly string[];
  agentName: string;
  grantedOperations: readonly string[];
}

export type ProjectNames = (
  ids: readonly string[],
) => ReadonlyMap<string, string>;

export interface LiveInvite extends ResolvedInvite {
  invited_by_name: string;
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

const projectIdSchema = identitySchema("project");
const projectIdsSchema = z.array(projectIdSchema);
const NO_PROJECTS: string[] = [];
const grantedOperationsSchema = z.array(z.string());
const NO_GRANT: string[] = [];

function grantedOperationsOf(stored: string): string[] {
  try {
    const parsed = grantedOperationsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : NO_GRANT;
  } catch {
    return NO_GRANT;
  }
}

function checkedGrant(agentName: string, ids: readonly string[]): string[] {
  const grantable = grantableOperations(agentName);
  const seen = new Set<string>();
  const refused = new Set<string>();
  for (const id of ids) {
    if (!grantable.has(id) || seen.has(id)) refused.add(id);
    seen.add(id);
  }
  if (refused.size > NO_CHARACTERS)
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkbenchErrorCode.GrantInvalid,
      "The grant names only operations that the host agent lists and that a grant can hold, each once.",
      [...refused],
    );
  return [...ids].sort();
}

function projectIdsOf(stored: string): string[] {
  try {
    const parsed = projectIdsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : NO_PROJECTS;
  } catch {
    return NO_PROJECTS;
  }
}

function projectInvalid(refused: readonly string[]): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    WorkbenchErrorCode.ProjectInvalid,
    "The invite names 1 to 50 existing projects, each once.",
    [...refused],
  );
}

function shapeRefusals(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const refused = new Set<string>();
  for (const id of ids) {
    if (!projectIdSchema.safeParse(id).success || seen.has(id)) refused.add(id);
    seen.add(id);
  }
  return [...refused];
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

  private readonly projectNames: ProjectNames;

  constructor(store: Store, projectNames: ProjectNames) {
    this.store = store;
    this.projectNames = projectNames;
  }

  private checkedProjects(ids: readonly string[]): string[] {
    if (ids.length === NO_CHARACTERS) throw projectInvalid([]);
    if (ids.length > WORKBENCH_INVITE_PROJECT_LIMIT)
      throw projectInvalid(ids.slice(WORKBENCH_INVITE_PROJECT_LIMIT));
    const refused = shapeRefusals(ids);
    const distinct = [...new Set(ids)].filter(
      (id) => projectIdSchema.safeParse(id).success,
    );
    const names = this.projectNames(distinct);
    const unknown = distinct.filter((id) => !names.has(id));
    const all = [...new Set([...refused, ...unknown])];
    if (all.length > NO_CHARACTERS) throw projectInvalid(all);
    return [...ids].sort();
  }

  create(
    sessionId: string,
    inviter: Inviter,
    request: InviteRequest,
  ): CreatedInvite {
    const name = inviteNameOf(request.name);
    const projectIds = JSON.stringify(this.checkedProjects(request.projectIds));
    const granted = checkedGrant(request.agentName, request.grantedOperations);
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
      const live = tx.database
        .prepare(
          "SELECT project_ids FROM workbench_invite WHERE session_id = ? AND expires_at > ? LIMIT 1",
        )
        .get(sessionId, now) as { project_ids: string } | undefined;
      if (live !== undefined && live.project_ids !== projectIds)
        throw new OperationError(
          HttpStatus.Conflict,
          WorkbenchErrorCode.ScopeMismatch,
          "The conversation has a live invite with another project set. Revoke it before you invite with a new set.",
        );
      tx.database
        .prepare(
          "INSERT INTO workbench_invite (id, session_id, token_hash, invited_by, invited_by_name, expires_at, invitee_name, project_ids, granted_operations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          sessionId,
          tokenHashOf(token),
          inviter.accountId,
          inviter.name,
          expiresAt,
          name,
          projectIds,
          JSON.stringify(granted),
        );
    });
    return {
      id,
      session_id: sessionId,
      granted_operations: granted,
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

  resolve(inviteId: string): LiveInvite | null {
    const row = this.store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT session_id, invited_by, invited_by_name, expires_at, project_ids, granted_operations FROM workbench_invite WHERE id = ? AND expires_at > ?",
          )
          .get(inviteId, Date.now()) as
          | (Omit<LiveInvite, "project_ids" | "granted_operations"> & {
              project_ids: string;
              granted_operations: string;
            })
          | undefined,
    );
    return row === undefined
      ? null
      : {
          ...row,
          project_ids: projectIdsOf(row.project_ids),
          granted_operations: grantedOperationsOf(row.granted_operations),
        };
  }

  list(sessionId: string): LiveInviteItem[] {
    return this.store
      .transaction((tx) =>
        tx.database
          .prepare(
            "SELECT id, invitee_name, expires_at, project_ids, granted_operations FROM workbench_invite WHERE session_id = ? AND expires_at > ? ORDER BY expires_at, id",
          )
          .all(sessionId, Date.now()),
      )
      .map((row) => {
        const {
          project_ids: stored,
          granted_operations: storedGrant,
          ...item
        } = row as unknown as InviteItem & {
          project_ids: string;
          granted_operations: string;
        };
        return {
          ...item,
          project_ids: projectIdsOf(stored),
          granted_operations: grantedOperationsOf(storedGrant),
        };
      });
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
