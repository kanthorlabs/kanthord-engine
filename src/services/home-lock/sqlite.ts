import fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FilesystemProbe,
  AcquireInput,
  HeldHome,
  HomeLock,
  HomeIdentity,
} from "./index.ts";
import { HomeLockError } from "./index.ts";
import { renderIdentity, parseIdentity } from "./identity.ts";

export type SqliteHomeLockDependencies = Readonly<{
  probe: FilesystemProbe;
  sleeper?: (milliseconds: number) => void;
}>;

const liveConnections = new Set<DatabaseSync>();

export class SqliteHomeLock implements HomeLock {
  private readonly probe: FilesystemProbe;
  private readonly sleeper: (milliseconds: number) => void;
  private held = false;

  constructor(dependencies: SqliteHomeLockDependencies) {
    this.probe = dependencies.probe;
    this.sleeper =
      dependencies.sleeper ??
      ((ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      });
  }

  acquire(input: AcquireInput): HeldHome {
    if (this.held) throw new Error("the home lock is already held");

    fs.mkdirSync(input.home, { recursive: true, mode: 0o700 });

    const kind = this.probe.classify(input.home);
    if (kind === "network") {
      throw new HomeLockError(
        "home-network-filesystem",
        `the daemon home ${input.home} is on a network filesystem`,
      );
    }

    const identityWaitMs = input.identityWaitMs ?? 200;
    const identityPollMs = input.identityPollMs ?? 20;

    let db: DatabaseSync | undefined;
    try {
      db = this.openAndBegin(input.home);
      return this.makeHeld(db, input.home);
    } catch (error: unknown) {
      if (db !== undefined) db.close();
      const sqliteErr = error as { errcode?: number; message?: string };
      if (sqliteErr.errcode === 5) {
        return this.handleContended(input, identityWaitMs, identityPollMs);
      }
      throw new HomeLockError(
        "home-lock-corrupt",
        `${input.home} is not a usable lock database: ${sqliteErr.message ?? String(error)}`,
      );
    }
  }

  private openAndBegin(home: string): DatabaseSync {
    const lockPath = join(home, "daemon.lock.db");
    const fd = fs.openSync(lockPath, "a", 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    const db = new DatabaseSync(lockPath);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA locking_mode = NORMAL");
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("BEGIN IMMEDIATE");
    } catch (error: unknown) {
      db.close();
      throw error;
    }
    return db;
  }

  private handleContended(
    input: AcquireInput,
    identityWaitMs: number,
    identityPollMs: number,
  ): HeldHome {
    const identityPath = join(input.home, "daemon.lock.identity");
    let sleepBudget = identityWaitMs;
    while (!fs.existsSync(identityPath) && sleepBudget > 0) {
      this.sleeper(identityPollMs);
      sleepBudget -= identityPollMs;
    }

    let holder: HomeIdentity | null = null;
    try {
      if (fs.existsSync(identityPath)) {
        holder = parseIdentity(fs.readFileSync(identityPath, "utf8"));
      }
    } catch {
      holder = null;
    }

    if (input.beforeRetry !== undefined) {
      input.beforeRetry();
    }

    let db: DatabaseSync | undefined;
    try {
      db = this.openAndBegin(input.home);
      return this.makeHeld(db, input.home);
    } catch (retryError: unknown) {
      if (db !== undefined) db.close();
      const sqliteErr = retryError as { errcode?: number; message?: string };
      if (sqliteErr.errcode === 5) {
        const message =
          holder !== null
            ? `the daemon home ${input.home} is locked by pid ${holder.pid} on ${holder.host} since ${holder.startedAt} (instance ${holder.instanceId})`
            : `the daemon home ${input.home} is locked by another process; the holder identity is unavailable`;
        throw new HomeLockError("home-locked", message, holder);
      }
      throw new HomeLockError(
        "home-lock-corrupt",
        `${input.home} is not a usable lock database: ${sqliteErr.message ?? String(retryError)}`,
        null,
      );
    }
  }

  private makeHeld(db: DatabaseSync, home: string): HeldHome {
    liveConnections.add(db);
    fs.rmSync(join(home, "daemon.lock.identity"), { force: true });
    this.held = true;
    let released = false;
    return {
      path: home,
      publishIdentity(identity: HomeIdentity) {
        if (released) throw new Error("the home lock is released");
        const tmpPath = join(
          home,
          `daemon.lock.identity.${identity.instanceId}.tmp`,
        );
        const finalPath = join(home, "daemon.lock.identity");
        fs.writeFileSync(tmpPath, renderIdentity(identity), { mode: 0o600 });
        fs.renameSync(tmpPath, finalPath);
      },
      release() {
        if (released) return;
        released = true;
        liveConnections.delete(db);
        db.close();
      },
    };
  }
}
