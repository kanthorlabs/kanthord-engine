import { constants, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { openPrivate } from "./files.ts";

export const LogDestination = {
  StandardError: "stderr",
  File: "file",
} as const;

export interface LogConfig {
  level: pino.Level;
  destination: (typeof LogDestination)[keyof typeof LogDestination];
}

export const redactionPaths = [
  "masterKey",
  "master_key",
  "password",
  "token",
  "clientSecret",
  "client_secret",
  "secret",
  "credential",
  "payload",
  "material",
  "report",
  "authorization",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "body.password",
  "body.clientSecret",
  "body.token",
  "body.masterKey",
  "body.client_secret",
  "body.master_key",
  "req.body.password",
  "req.body.clientSecret",
  "req.body.token",
  "req.body.masterKey",
  "req.body.client_secret",
  "req.body.master_key",
  "config.master_key",
  "config.client_secret",
];

export class OperationalLog {
  readonly logger: pino.Logger;
  private fd = 2;
  private destination: ReturnType<typeof pino.destination>;
  private readonly path?: string;
  private closed = false;
  private readonly closing: Promise<void>[] = [];

  constructor(config: LogConfig, stateDirectory: string) {
    if (config.destination === LogDestination.File) {
      this.path = join(stateDirectory, "kanthord.log");
      this.fd = openPrivate(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      );
    }
    this.destination = pino.destination({ fd: this.fd, sync: true });
    this.logger = pino(
      {
        level: config.level,
        redact: { paths: redactionPaths, censor: "[Redacted]" },
      },
      {
        write: (line: string) => this.destination.write(line),
      },
    );
  }

  descriptor(): number {
    return this.fd;
  }

  healthcheck(): boolean {
    if (this.closed) return false;
    try {
      fstatSync(this.fd);
      return true;
    } catch {
      return false;
    }
  }

  reopen(): void {
    if (!this.path || this.closed) return;
    const fd = openPrivate(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    );
    try {
      this.destination.flushSync();
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const replacement = pino.destination({ fd, sync: true });
    this.retire(this.destination);
    this.fd = fd;
    this.destination = replacement;
  }

  private retire(destination: ReturnType<typeof pino.destination>): void {
    const closed = new Promise<void>((resolve, reject) => {
      destination.once("close", resolve);
      destination.once("error", reject);
    });
    // close() joins every descriptor, including files retired by SIGHUP.
    void closed.catch(() => {});
    this.closing.push(closed);
    destination.destroy();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.destination.flushSync();
    this.retire(this.destination);
    this.closed = true;
    await Promise.all(this.closing);
  }
}
