import { DatabaseSync } from "node:sqlite";

import type { Transaction } from "./index.ts";
import { StorageError } from "./index.ts";

export const pragmas = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = FULL",
  "PRAGMA busy_timeout = 5000",
] as const;

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    for (const pragma of pragmas) {
      database.exec(pragma);
    }
  } catch (error) {
    try {
      database.close();
    } catch {
      // the pragma error wins
    }
    throw error;
  }
  return database;
}

export function runInTransaction<T>(
  database: DatabaseSync,
  work: (transaction: Transaction) => T,
): T {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    throw withCause(
      new StorageError(
        "storage-transaction-failed",
        `begin failed: ${message(cause)}`,
      ),
      cause,
    );
  }

  let open = true;
  const context: Transaction = {
    run(sql, parameters = []) {
      if (!open) {
        throw new StorageError(
          "storage-transaction-failed",
          "the transaction is closed",
        );
      }
      database.prepare(sql).run(...(parameters as never[]));
    },
    get(sql, parameters = []) {
      if (!open) {
        throw new StorageError(
          "storage-transaction-failed",
          "the transaction is closed",
        );
      }
      return database.prepare(sql).get(...(parameters as never[]));
    },
    all(sql, parameters = []) {
      if (!open) {
        throw new StorageError(
          "storage-transaction-failed",
          "the transaction is closed",
        );
      }
      return database.prepare(sql).all(...(parameters as never[]));
    },
  };

  let result: T;
  try {
    result = work(context);
  } catch (error) {
    open = false;
    try {
      database.exec("ROLLBACK");
    } catch {
      // the work error wins
    }
    throw error;
  }

  if (isThenable(result)) {
    open = false;
    try {
      database.exec("ROLLBACK");
    } catch {
      // the thenable error wins
    }
    throw new StorageError(
      "storage-transaction-failed",
      "transact work must be synchronous",
    );
  }

  try {
    database.exec("COMMIT");
  } catch (cause) {
    open = false;
    try {
      database.exec("ROLLBACK");
    } catch {
      // the commit error wins
    }
    throw withCause(
      new StorageError(
        "storage-transaction-failed",
        `commit failed: ${message(cause)}`,
      ),
      cause,
    );
  }

  open = false;
  return result;
}

function withCause(error: StorageError, cause: unknown): StorageError {
  error.cause = cause;
  return error;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
