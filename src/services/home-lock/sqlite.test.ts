import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import v8 from "node:v8";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

import { SqliteHomeLock } from "./sqlite.ts";
import { HomeLockError } from "./index.ts";
import { renderIdentity } from "./identity.ts";
import type { FilesystemProbe, FilesystemKind, HomeIdentity } from "./index.ts";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kanthord-home-"));
}

function fakeProbe(kind: FilesystemKind): FilesystemProbe {
  return { classify: () => kind };
}

describe("src/services/home-lock/sqlite.test", () => {
  it('fake probe "local" acquires, daemon.lock.db exists at mode 0o600', () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    const lockPath = path.join(home, "daemon.lock.db");
    assert.ok(fs.existsSync(lockPath));
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    held.release();
  });

  it("existing daemon.lock.db at 0o644 becomes 0o600 after acquire, inode unchanged", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lockPath = path.join(home, "daemon.lock.db");
    fs.writeFileSync(lockPath, "");
    fs.chmodSync(lockPath, 0o644);
    const inoBefore = fs.statSync(lockPath).ino;
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(lockPath).ino, inoBefore);
    held.release();
  });

  it("acquire on non-existent home creates it at mode 0o700", () => {
    const parent = tmpHome();
    after(() => fs.rmSync(parent, { recursive: true }));
    const home = path.join(parent, "does-not-exist");
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    assert.ok(fs.existsSync(home));
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    held.release();
  });

  it('mock probe "network" throws HomeLockError "home-network-filesystem"', () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("network") });
    assert.throws(
      () => lock.acquire({ home }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-network-filesystem");
        assert.match(err.message, new RegExp(home));
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(home, "daemon.lock.db")));
  });

  it('probe "unknown" acquires', () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("unknown") });
    const held = lock.acquire({ home });
    assert.ok(fs.existsSync(path.join(home, "daemon.lock.db")));
    held.release();
  });

  it("second acquire on same instance throws /already held/ and is not HomeLockError", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    assert.throws(
      () => lock.acquire({ home }),
      (err: unknown) => {
        assert.ok(!(err instanceof HomeLockError));
        assert.match((err as Error).message, /already held/);
        return true;
      },
    );
    held.release();
  });

  it('two instances on one home: second throws code "home-locked"', () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    const held1 = lock1.acquire({ home });
    assert.throws(
      () => lock2.acquire({ home, identityWaitMs: 0, identityPollMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.match(err.message, new RegExp(home));
        return true;
      },
    );
    held1.release();
  });

  it("the lock connection survives garbage collection while the home is held", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    v8.setFlagsFromString("--expose_gc");
    const collect = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose_gc");

    const held = new SqliteHomeLock({ probe: fakeProbe("local") }).acquire({
      home,
    });
    collect();
    collect();

    const contender = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    assert.throws(
      () => contender.acquire({ home, identityWaitMs: 0, identityPollMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        return true;
      },
    );

    held.release();
    collect();
    const after1 = new SqliteHomeLock({ probe: fakeProbe("local") }).acquire({
      home,
    });
    after1.release();
  });

  it("after release(), third instance acquires", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const lock2 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    held1.release();
    const held2 = lock2.acquire({ home });
    assert.ok(fs.existsSync(path.join(home, "daemon.lock.db")));
    held2.release();
  });

  it("release() twice does not throw", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    held.release();
    held.release();
  });

  it('daemon.lock.db with "not a database at all" throws "home-lock-corrupt", file exists, bytes unchanged', () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lockPath = path.join(home, "daemon.lock.db");
    const payload = Buffer.from("not a database at all");
    fs.writeFileSync(lockPath, payload);
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    assert.throws(
      () => lock.acquire({ home }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-lock-corrupt");
        return true;
      },
    );
    assert.ok(fs.existsSync(lockPath));
    assert.ok(fs.readFileSync(lockPath).equals(payload));
  });

  it("second node:sqlite database at kanthord.db works while lock held", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    const dbPath = path.join(home, "kanthord.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("INSERT INTO t (v) VALUES ('hello')");
    const row: any = db.prepare("SELECT v FROM t WHERE id = 1").get();
    assert.equal(row.v, "hello");
    db.close();
    held.release();
  });

  it("BEGIN IMMEDIATE leaves journal, release() removes it", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    const journalPath = path.join(home, "daemon.lock.db-journal");
    assert.ok(fs.existsSync(journalPath));
    held.release();
    assert.ok(!fs.existsSync(journalPath));
  });

  it("daemon.lock.identity before acquire is gone after acquire", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const identityPath = path.join(home, "daemon.lock.identity");
    fs.writeFileSync(identityPath, "stale-pid");
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    assert.ok(!fs.existsSync(identityPath));
    held.release();
  });

  const sampleIdentity: HomeIdentity = {
    version: 1,
    pid: process.pid,
    host: "testhost",
    startedAt: "2026-08-03T10:00:00.000Z",
    instanceId: "01TESTINSTANCE",
  };

  it("publishIdentity writes daemon.lock.identity at 0o600, bytes match renderIdentity, no tmp remains", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    held.publishIdentity(sampleIdentity);
    const identityPath = path.join(home, "daemon.lock.identity");
    assert.ok(fs.existsSync(identityPath));
    assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(identityPath, "utf8"),
      renderIdentity(sampleIdentity),
    );
    const tmpFiles = fs.readdirSync(home).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(tmpFiles, []);
    held.release();
  });

  it("publishIdentity after release() throws /released/, no file written", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held = lock.acquire({ home });
    held.release();
    assert.throws(
      () => held.publishIdentity(sampleIdentity),
      (err: unknown) => {
        assert.match((err as Error).message, /released/);
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(home, "daemon.lock.identity")));
  });

  it("holder published, second instance: throws home-locked, error.holder deep-equals identity, message has pid/host/startedAt/instanceId", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    const held1 = lock1.acquire({ home });
    held1.publishIdentity(sampleIdentity);
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.deepEqual(err.holder, sampleIdentity);
        assert.match(err.message, new RegExp(String(sampleIdentity.pid)));
        assert.match(err.message, /testhost/);
        assert.match(err.message, /2026-08-03T10:00:00\.000Z/);
        assert.match(err.message, /01TESTINSTANCE/);
        return true;
      },
    );
    held1.release();
  });

  it("holder never published: second instance throws home-locked, error.holder null, message unavailable", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    const held1 = lock1.acquire({ home });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.equal(err.holder, null);
        assert.match(err.message, /unavailable/);
        return true;
      },
    );
    held1.release();
  });

  it("truncated identity file: second instance throws home-locked with null holder", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    const held1 = lock1.acquire({ home });
    const identityPath = path.join(home, "daemon.lock.identity");
    fs.writeFileSync(identityPath, '{\n  "version": 1,\n  "pid": 16801', {
      mode: 0o600,
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.equal(err.holder, null);
        assert.match(err.message, /unavailable/);
        return true;
      },
    );
    held1.release();
  });

  it("beforeRetry releasing holder makes acquire succeed, beforeRetry ran exactly once", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    let retryCount = 0;
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    const held2 = lock2.acquire({
      home,
      identityWaitMs: 0,
      identityPollMs: 20,
      beforeRetry: () => {
        retryCount++;
        held1.release();
      },
    });
    assert.equal(retryCount, 1);
    assert.equal(held2.path, home);
    held2.release();
  });

  it("beforeRetry that does nothing: still throws, still ran once", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    let retryCount = 0;
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {},
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
          beforeRetry: () => {
            retryCount++;
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        return true;
      },
    );
    assert.equal(retryCount, 1);
    held1.release();
  });

  it("identityWaitMs: 0 → sleeper never called, throws home-locked", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    let sleepCalls = 0;
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {
        sleepCalls++;
      },
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        return true;
      },
    );
    assert.equal(sleepCalls, 0);
    held1.release();
  });

  it("identityWaitMs: 100, identityPollMs: 20, no identity → sleeper called exactly 5 times", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    const sleepArgs: number[] = [];
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: (ms) => {
        sleepArgs.push(ms);
      },
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 100,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        return true;
      },
    );
    assert.equal(sleepArgs.length, 5);
    assert.ok(sleepArgs.every((ms) => ms === 20));
    held1.release();
  });

  it("identityWaitMs: 100, identityPollMs: 20, identity present → sleeper never called, error.holder matches", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    held1.publishIdentity(sampleIdentity);
    let sleepCalls = 0;
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {
        sleepCalls++;
      },
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 100,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.deepEqual(err.holder, sampleIdentity);
        return true;
      },
    );
    assert.equal(sleepCalls, 0);
    held1.release();
  });

  it("predecessor race: valid identity for pid 999999, first acquire does NOT publish, second refused, error.holder null, message unavailable", () => {
    const home = tmpHome();
    after(() => fs.rmSync(home, { recursive: true }));
    const staleIdentity: HomeIdentity = {
      version: 1,
      pid: 999999,
      host: "stalehost",
      startedAt: "2026-08-03T09:00:00.000Z",
      instanceId: "01STALESTALE",
    };
    const identityPath = path.join(home, "daemon.lock.identity");
    fs.writeFileSync(identityPath, renderIdentity(staleIdentity), {
      mode: 0o600,
    });
    const lock1 = new SqliteHomeLock({ probe: fakeProbe("local") });
    const held1 = lock1.acquire({ home });
    let sleepCalls = 0;
    const lock2 = new SqliteHomeLock({
      probe: fakeProbe("local"),
      sleeper: () => {
        sleepCalls++;
      },
    });
    assert.throws(
      () =>
        lock2.acquire({
          home,
          identityWaitMs: 0,
          identityPollMs: 20,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HomeLockError);
        assert.equal(err.code, "home-locked");
        assert.equal(err.holder, null);
        assert.match(err.message, /unavailable/);
        assert.doesNotMatch(err.message, /999999/);
        return true;
      },
    );
    assert.equal(sleepCalls, 0);
    held1.release();
  });

  describe("sweepRefLocks", () => {
    it("no repos directory returns [] and creates nothing", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));
      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      const result = held.sweepRefLocks();
      assert.deepEqual(result, []);
      assert.ok(!fs.existsSync(path.join(home, "repos")));
      held.release();
    });

    it("empty repos directory returns []", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));
      fs.mkdirSync(path.join(home, "repos"));
      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      const result = held.sweepRefLocks();
      assert.deepEqual(result, []);
      held.release();
    });

    it("removes .lock files inside *.git dirs, returns paths in bytewise order", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const lockA = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "main.lock",
      );
      const lockB = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "x",
        "y.lock",
      );
      const lockC = path.join(home, "repos", "b.git", "config.lock");

      fs.mkdirSync(path.dirname(lockA), { recursive: true });
      fs.mkdirSync(path.dirname(lockB), { recursive: true });
      fs.mkdirSync(path.dirname(lockC), { recursive: true });
      fs.writeFileSync(lockA, "");
      fs.writeFileSync(lockB, "");
      fs.writeFileSync(lockC, "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      const result = held.sweepRefLocks();

      const expected = [lockA, lockB, lockC].sort((a, b) =>
        Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
      );
      assert.deepEqual(result, expected);
      assert.ok(!fs.existsSync(lockA));
      assert.ok(!fs.existsSync(lockB));
      assert.ok(!fs.existsSync(lockC));
      held.release();
    });

    it("non-.lock files and .lock.keep survive", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const mainRef = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "main",
      );
      const headRef = path.join(home, "repos", "a.git", "HEAD");
      const keepRef = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "main.lock.keep",
      );
      const staleLock = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "stale.lock",
      );

      fs.mkdirSync(path.dirname(mainRef), { recursive: true });
      fs.writeFileSync(mainRef, "ref-content");
      fs.writeFileSync(headRef, "HEAD-content");
      fs.writeFileSync(keepRef, "keep-content");
      fs.writeFileSync(staleLock, "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      held.sweepRefLocks();

      assert.ok(fs.existsSync(mainRef));
      assert.ok(fs.existsSync(headRef));
      assert.ok(fs.existsSync(keepRef));
      assert.ok(!fs.existsSync(staleLock));
      held.release();
    });

    it("repos/loose.lock directly under repos survives", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const looseLock = path.join(home, "repos", "loose.lock");
      fs.mkdirSync(path.join(home, "repos"));
      fs.writeFileSync(looseLock, "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      held.sweepRefLocks();

      assert.ok(fs.existsSync(looseLock));
      held.release();
    });

    it("directory named something.lock survives", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const dirLock = path.join(home, "repos", "a.git", "something.lock");
      fs.mkdirSync(dirLock, { recursive: true });
      fs.writeFileSync(path.join(dirLock, "inner"), "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      held.sweepRefLocks();

      assert.ok(fs.existsSync(dirLock));
      assert.ok(fs.statSync(dirLock).isDirectory());
      held.release();
    });

    it("daemon.lock.db and daemon.lock.identity survive after sweep", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const staleLock = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "main.lock",
      );
      fs.mkdirSync(path.dirname(staleLock), { recursive: true });
      fs.writeFileSync(staleLock, "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      held.publishIdentity(sampleIdentity);
      held.sweepRefLocks();

      assert.ok(fs.existsSync(path.join(home, "daemon.lock.db")));
      assert.ok(fs.existsSync(path.join(home, "daemon.lock.identity")));
      held.release();
    });

    it("ordering is bytewise (Buffer.compare): Z.lock, a.lock, é.lock", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));

      const zLock = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "Z.lock",
      );
      const aLock = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "a.lock",
      );
      const eLock = path.join(
        home,
        "repos",
        "a.git",
        "refs",
        "heads",
        "é.lock",
      );

      fs.mkdirSync(path.dirname(zLock), { recursive: true });
      fs.writeFileSync(zLock, "");
      fs.writeFileSync(aLock, "");
      fs.writeFileSync(eLock, "");

      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      const result = held.sweepRefLocks();

      const expected = [zLock, aLock, eLock].sort((x, y) =>
        Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8")),
      );
      assert.deepEqual(result, expected);
      assert.ok(!fs.existsSync(zLock));
      assert.ok(!fs.existsSync(aLock));
      assert.ok(!fs.existsSync(eLock));
      held.release();
    });

    it("sweepRefLocks after release() throws /released/", () => {
      const home = tmpHome();
      after(() => fs.rmSync(home, { recursive: true }));
      const lock = new SqliteHomeLock({ probe: fakeProbe("local") });
      const held = lock.acquire({ home });
      held.release();
      assert.throws(
        () => held.sweepRefLocks(),
        (err: unknown) => {
          assert.match((err as Error).message, /released/);
          return true;
        },
      );
    });
  });

  it("module exports exactly one name: SqliteHomeLock", async () => {
    const mod = await import("./sqlite.ts");
    assert.deepEqual(Object.keys(mod), ["SqliteHomeLock"]);
  });
});
