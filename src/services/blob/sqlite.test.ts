import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import type { Storage } from "../storage/index.ts";
import { StorageError } from "../storage/index.ts";
import { BlobStoreError } from "./index.ts";
import { SqliteBlobStore } from "./sqlite.ts";

const kanthordHash =
  "sha256:6716f913a54334239c6614653425bad87302dbc49f3d7ccc3d9d7c44ecfaf7ac";
const emptyHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function build(): {
  storage: Storage;
  store: SqliteBlobStore;
  dispose(): void;
} {
  const temporary = createMigratedStorage();
  return {
    storage: temporary.storage,
    store: new SqliteBlobStore({
      storage: temporary.storage,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
    }),
    dispose: temporary.dispose,
  };
}

describe("src/services/blob/sqlite.test", () => {
  it("put returns the pinned sha256 of kanthord", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const hash = storage.transact((t) =>
      store.put(t, Buffer.from("kanthord", "utf8")),
    );
    assert.equal(hash, kanthordHash);
  });

  it("put of the empty payload returns the pinned empty sha256", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const hash = storage.transact((t) => store.put(t, new Uint8Array()));
    assert.equal(hash, emptyHash);
  });

  it("get returns the stored record with content as a Uint8Array", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const hash = storage.transact((t) =>
      store.put(t, Buffer.from("kanthord", "utf8")),
    );
    const record = store.get(hash);

    assert.ok(record);
    assert.equal(record.hash, kanthordHash);
    assert.equal(record.size, 8);
    assert.equal(record.createdAt, 1700000000000);
    assert.equal(
      Buffer.compare(record.content, Buffer.from("kanthord", "utf8")),
      0,
    );
    assert.equal(Object.getPrototypeOf(record.content), Uint8Array.prototype);
  });

  it("the same bytes written twice produce one row and one hash", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const first = storage.transact((t) =>
      store.put(t, Buffer.from("kanthord", "utf8")),
    );
    const second = storage.transact((t) =>
      store.put(t, Buffer.from("kanthord", "utf8")),
    );
    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM blob") as { c: number },
    );
    const record = store.get(first);

    assert.equal(first, kanthordHash);
    assert.equal(second, kanthordHash);
    assert.equal(count.c, 1);
    assert.equal(record?.createdAt, 1700000000000);
  });

  it("two different payloads produce two hashes and two rows", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const first = storage.transact((t) =>
      store.put(t, Buffer.from("kanthord", "utf8")),
    );
    const second = storage.transact((t) =>
      store.put(t, Buffer.from("blobstore", "utf8")),
    );
    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM blob") as { c: number },
    );

    assert.notEqual(first, second);
    assert.equal(count.c, 2);
  });

  it("get of a valid hash with no row returns null", () => {
    const { store, dispose } = build();
    after(() => dispose());

    assert.equal(store.get(`sha256:${"9".repeat(64)}`), null);
  });

  it("get refuses a non-sha256 hash", () => {
    const { store, dispose } = build();
    after(() => dispose());

    assert.throws(
      () => store.get("nonsense"),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError);
        assert.equal(error.name, "BlobStoreError");
        assert.equal(error.code, "blob-hash-invalid");
        assert.equal(error.message, "nonsense is not a sha256 blob hash");
        return true;
      },
    );
  });

  it("get refuses an uppercase-hex hash", () => {
    const { store, dispose } = build();
    after(() => dispose());

    assert.throws(
      () => store.get(`sha256:${"A".repeat(64)}`),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError);
        assert.equal(error.code, "blob-hash-invalid");
        return true;
      },
    );
  });

  it("get refuses a 63-character hash", () => {
    const { store, dispose } = build();
    after(() => dispose());

    assert.throws(
      () => store.get(`sha256:${"a".repeat(63)}`),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError);
        assert.equal(error.code, "blob-hash-invalid");
        return true;
      },
    );
  });

  it("a rolled-back transaction stores nothing", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const hash = kanthordHash;
    assert.throws(() =>
      storage.transact((t) => {
        store.put(t, Buffer.from("kanthord", "utf8"));
        throw new Error("boom");
      }),
    );

    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM blob") as { c: number },
    );
    assert.equal(count.c, 0);
    assert.equal(store.get(hash), null);
  });

  it("get reads a blob written earlier in the caller's own transaction", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    const record = storage.transact((t) => {
      const hash = store.put(t, Buffer.from("kanthord", "utf8"));
      return store.get(hash, t);
    });

    assert.ok(record);
    assert.equal(record.hash, kanthordHash);
    assert.equal(record.size, 8);
    assert.equal(Buffer.from(record.content).toString("utf8"), "kanthord");
  });

  it("get without the caller's transaction refuses inside an open transaction", () => {
    const { storage, store, dispose } = build();
    after(() => dispose());

    assert.throws(
      () =>
        storage.transact((t) => {
          const hash = store.put(t, Buffer.from("kanthord", "utf8"));
          return store.get(hash);
        }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "storage-transaction-failed");
        assert.equal(error.message, "a transaction is already open");
        return true;
      },
    );
  });
});
