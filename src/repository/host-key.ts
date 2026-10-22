import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { ulid } from "ulid";
import { z } from "zod";
import { LIST_LIMIT_DEFAULT } from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { type Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { isString } from "../kernel/values.ts";
import {
  HOST_KEY_SCAN_FAILED_STATUS,
  HostKeyErrorCode,
  HostKeySource,
  repositoryOperations,
  type HostKeyItem,
  type HostKeyListAnswer,
  type HostKeyListQuery,
  type HostKeyScanAnswer,
} from "./contract.ts";
import {
  isGitHubSshHost,
  isSshHost,
  sshKnownHostsName,
  sshPortOf,
} from "./platform.ts";
import { sshFingerprintOf } from "./ssh-key.ts";

export interface HostKeySources {
  githubMeta(context: Context, deadlineMs: number): Promise<unknown>;
  keyscan(host: string, context: Context, deadlineMs: number): Promise<string>;
}

export interface HostKeyDependencies {
  logger: Logger;
  sources?: HostKeySources;
}

const ED25519_TYPE = "ssh-ed25519";
const ED25519_KEY_BYTES = 32;
const LENGTH_BYTES = 4;
const TYPE_LENGTH_OFFSET = 0;
const ED25519_BLOB_BYTES =
  LENGTH_BYTES + ED25519_TYPE.length + LENGTH_BYTES + ED25519_KEY_BYTES;
const HOST_KEY_PREFIX = "host_key";
const HOST_KEY_READ_TIMEOUT_MS = 10_000;
const KEYSCAN_TIMEOUT_SECONDS = "5";
const GITHUB_META_URL = "https://api.github.com/meta";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "kanthord";
const COMMENT_PREFIX = "#";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVALID_CURSOR = "system.pagination.cursor_invalid";
const EXTRA_ROW = 1;
const NO_ROWS = 0;
const EXPIRED = 0;

const execFileAsync = promisify(execFile);

function withDeadline<T>(
  context: Context,
  deadlineMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancellation = addAbortListener(context.signal, () =>
    controller.abort(context.signal.reason),
  );
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(EXPIRED, deadlineMs),
  );
  return run(controller.signal).finally(() => {
    clearTimeout(timer);
    cancellation[Symbol.dispose]();
  });
}

export function keyscanArguments(host: string): string[] {
  return [
    "-T",
    KEYSCAN_TIMEOUT_SECONDS,
    "-t",
    "ed25519",
    "-p",
    String(sshPortOf(host)),
    "--",
    host,
  ];
}

export const liveHostKeySources: HostKeySources = {
  githubMeta: (context, deadlineMs) =>
    withDeadline(context, deadlineMs, async (signal) => {
      const response = await fetch(GITHUB_META_URL, {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": USER_AGENT,
        },
      });
      if (!response.ok)
        throw new Error(`GitHub meta answered ${response.status}`);
      return response.json();
    }),
  keyscan: (host, context, deadlineMs) =>
    withDeadline(context, deadlineMs, async (signal) => {
      assert.ok(isSshHost(host));
      const { stdout } = await execFileAsync(
        "ssh-keyscan",
        keyscanArguments(host),
        { signal, env: { PATH: process.env.PATH } },
      );
      return stdout;
    }),
};

const githubMetaSchema = z.object({ ssh_keys: z.array(z.unknown()) });

function ed25519PublicKey(type: unknown, body: unknown): string | null {
  if (type !== ED25519_TYPE || !isString(body)) return null;
  const blob = Buffer.from(body, "base64");
  if (
    blob.length !== ED25519_BLOB_BYTES ||
    blob.toString("base64") !== body ||
    blob.readUInt32BE(TYPE_LENGTH_OFFSET) !== ED25519_TYPE.length ||
    blob.toString(
      "latin1",
      LENGTH_BYTES,
      LENGTH_BYTES + ED25519_TYPE.length,
    ) !== ED25519_TYPE ||
    blob.readUInt32BE(LENGTH_BYTES + ED25519_TYPE.length) !== ED25519_KEY_BYTES
  )
    return null;
  return `${ED25519_TYPE} ${body}`;
}

export function parseGitHubMeta(body: unknown): string | null {
  const meta = githubMetaSchema.safeParse(body);
  if (!meta.success) return null;
  const entry = meta.data.ssh_keys.find(
    (key): key is string => isString(key) && key.startsWith(`${ED25519_TYPE} `),
  );
  if (entry === undefined) return null;
  const [type, text] = entry.split(" ");
  return ed25519PublicKey(type, text);
}

export function parseKeyscan(host: string, stdout: string): string | null {
  const known = sshKnownHostsName(host);
  for (const line of stdout.split("\n")) {
    if (line.startsWith(COMMENT_PREFIX)) continue;
    const [name, type, body] = line.trim().split(/\s+/);
    if (name !== known) continue;
    const key = ed25519PublicKey(type, body);
    if (key !== null) return key;
  }
  return null;
}

function sourceOf(host: string): HostKeySource {
  return isGitHubSshHost(host)
    ? HostKeySource.GitHubMeta
    : HostKeySource.Keyscan;
}

function supportedHost(host: string): string {
  if (!isSshHost(host))
    throw new OperationError(
      HttpStatus.BadRequest,
      HostKeyErrorCode.HostUnsupported,
      "The host is in no SSH host set.",
      { host },
    );
  return host.toLowerCase();
}

function decodeCursor(cursor: string): string {
  const host = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    !CURSOR_PATTERN.test(cursor) ||
    !isSshHost(host) ||
    Buffer.from(host, "utf8").toString("base64url") !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      INVALID_CURSOR,
      "Invalid cursor.",
    );
  return host;
}

type HostKeyRow = { host: string; public_key: string; created_at: number };

function itemOf(row: HostKeyRow): HostKeyItem {
  return {
    host: row.host,
    public_key: row.public_key,
    fingerprint: sshFingerprintOf(row.public_key),
    source: sourceOf(row.host),
    created_at: row.created_at,
  };
}

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export function knownHostsLine(tx: Transaction, host: string): string {
  const name = host.toLowerCase();
  const row = tx.database
    .prepare("SELECT public_key FROM repository_host_key WHERE host = ?")
    .get(name) as { public_key: string } | undefined;
  if (row === undefined)
    throw new OperationError(
      HttpStatus.Conflict,
      HostKeyErrorCode.Unpinned,
      "The SSH host holds no pinned host key.",
      { host: name },
    );
  return `${sshKnownHostsName(name)} ${row.public_key}`;
}

export class RepositoryHostKeys {
  private readonly logger: Logger;
  private readonly sources: HostKeySources;

  constructor(dependencies: HostKeyDependencies) {
    this.logger = dependencies.logger;
    this.sources = dependencies.sources ?? liveHostKeySources;
  }

  declare(registry: OperationRegistry): void {
    registry.register(repositoryOperations.host_key_list, (input, caller) =>
      caller.commit((tx) => this.list(tx, input.query)),
    );
    registry.register(
      repositoryOperations.host_key_scan,
      async (input, caller) => {
        const answer = await this.scan(input.body.host, caller.context);
        caller.context.signal.throwIfAborted();
        return caller.commit(() => answer);
      },
    );
    registry.register(
      repositoryOperations.host_key_pin,
      async (input, caller) => {
        const host = supportedHost(input.params.host);
        const read = await this.scan(host, caller.context);
        caller.context.signal.throwIfAborted();
        if (read.fingerprint !== input.body.fingerprint)
          throw new OperationError(
            HttpStatus.Conflict,
            HostKeyErrorCode.Changed,
            "The host presented another fingerprint.",
            { host, fingerprint: read.fingerprint },
          );
        return caller.commit((tx) =>
          this.replace(tx, read, humanIdentity(caller)),
        );
      },
    );
  }

  async scan(host: string, context: Context): Promise<HostKeyScanAnswer> {
    const name = supportedHost(host);
    const source = sourceOf(name);
    let key: string | null;
    try {
      key =
        source === HostKeySource.GitHubMeta
          ? parseGitHubMeta(
              await this.sources.githubMeta(context, HOST_KEY_READ_TIMEOUT_MS),
            )
          : parseKeyscan(
              name,
              await this.sources.keyscan(
                name,
                context,
                HOST_KEY_READ_TIMEOUT_MS,
              ),
            );
    } catch {
      context.signal.throwIfAborted();
      key = null;
    }
    if (key === null)
      throw new OperationError(
        HOST_KEY_SCAN_FAILED_STATUS,
        HostKeyErrorCode.ScanFailed,
        "The host key read failed.",
        { host: name },
      );
    return {
      host: name,
      public_key: key,
      fingerprint: sshFingerprintOf(key),
      source,
    };
  }

  list(tx: Transaction, query: HostKeyListQuery): HostKeyListAnswer {
    const after = query.cursor === undefined ? "" : decodeCursor(query.cursor);
    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const rows = tx.database
      .prepare(
        "SELECT host, public_key, created_at FROM repository_host_key WHERE host > ? ORDER BY host ASC LIMIT ?",
      )
      .all(after, limit + EXTRA_ROW) as HostKeyRow[];
    const page = rows.slice(NO_ROWS, limit);
    return {
      items: page.map(itemOf),
      next_cursor:
        rows.length > limit
          ? Buffer.from(page.at(-1)!.host, "utf8").toString("base64url")
          : null,
    };
  }

  knownHostsLine(tx: Transaction, host: string): string {
    return knownHostsLine(tx, host);
  }

  private replace(
    tx: Transaction,
    read: HostKeyScanAnswer,
    identity: string | undefined,
  ): HostKeyItem {
    assert.ok(tx.database.isTransaction);
    const row: HostKeyRow = {
      host: read.host,
      public_key: read.public_key,
      created_at: Date.now(),
    };
    tx.database
      .prepare("DELETE FROM repository_host_key WHERE host = ?")
      .run(row.host);
    tx.database
      .prepare(
        "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        `${HOST_KEY_PREFIX}_${ulid()}`,
        row.host,
        row.public_key,
        row.created_at,
      );
    this.logger.info(
      {
        human_identity: identity,
        host: read.host,
        fingerprint: read.fingerprint,
        source: read.source,
      },
      "host key pinned",
    );
    return itemOf(row);
  }
}
