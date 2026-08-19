/// <reference path="./convict.d.ts" />
import fs from "node:fs";
import path from "node:path";
import convict from "convict";

import type { Config, LoadInput, Loaded } from "./index.ts";
import { ConfigError } from "./index.ts";
import { searchOrder } from "./search-order.ts";
import { assertStartable } from "./refusals.ts";
import { deriveAllowedHosts } from "../../domain/host-authority.ts";
import { canonicalizeOrigin } from "../../domain/origin.ts";

function nonEmptyString(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("must be a non-empty string");
  }
}

function hostList(value: unknown): void {
  if (value === null) {
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("must be a non-empty array");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("every entry must be a non-empty string");
    }
  }
}

function originList(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("must be an array");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("every entry must be a non-empty string");
    }
  }
}

function positiveInteger(value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("must be a positive integer >= 1");
  }
}

function nonNegativeInteger(value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("must be a non-negative integer >= 0");
  }
}

function parseEnvInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    return NaN;
  }
  return Number(value);
}

function trimSingleTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

type RestrictedSecretHandle = Readonly<{
  mode: number;
  read(): string;
  close(): void;
}>;

function osErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "UNKNOWN";
}

function restrictedSecretError(
  err: unknown,
  settingName: string,
  filePath: string,
): ConfigError {
  const code = osErrorCode(err);
  if (code === "ENOENT") {
    return new ConfigError(
      "config-invalid",
      `${settingName} not found: ${filePath}`,
    );
  }
  return new ConfigError(
    "config-refused",
    `${settingName} refused at ${filePath}: ${code}`,
  );
}

function openRestrictedSecretFile(
  filePath: string,
  settingName: string,
): RestrictedSecretHandle {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (err: unknown) {
    throw restrictedSecretError(err, settingName, filePath);
  }

  let mode: number;
  try {
    mode = fs.fstatSync(descriptor).mode;
  } catch (err: unknown) {
    fs.closeSync(descriptor);
    throw restrictedSecretError(err, settingName, filePath);
  }

  let closed = false;
  return {
    mode,
    read(): string {
      try {
        return fs.readFileSync(descriptor, "utf-8");
      } catch (err: unknown) {
        throw restrictedSecretError(err, settingName, filePath);
      }
    },
    close(): void {
      if (!closed) {
        closed = true;
        fs.closeSync(descriptor);
      }
    },
  };
}

function absolutePath(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("must be a non-empty string");
  }
  if (!path.isAbsolute(value)) {
    throw new Error("must be an absolute path");
  }
}

function buildSchema(): Record<string, unknown> {
  return {
    home: { format: "nonEmptyString", default: null, env: "KANTHORD_HOME" },
    actor: { format: "nonEmptyString", default: null, env: "KANTHORD_ACTOR" },
    masterKey: { format: "String", default: "", env: "KANTHORD_MASTER_KEY" },
    masterKeyFile: {
      format: "String",
      default: "",
      env: "KANTHORD_MASTER_KEY_FILE",
    },
    http: {
      bind: {
        format: "nonEmptyString",
        default: "127.0.0.1",
        env: "KANTHORD_HTTP_BIND",
      },
      // Easter egg: the two pinned ports spell a constant each. 31415 is pi and
      // it belongs to the daemon; 27182 is Euler's number and it belongs to the
      // browser. Read them as one pair.
      port: { format: "port", default: 31415, env: "KANTHORD_HTTP_PORT" },
      token: { format: "String", default: "", env: "KANTHORD_HTTP_TOKEN" },
      tokenFile: {
        format: "String",
        default: "",
        env: "KANTHORD_HTTP_TOKEN_FILE",
      },
      allowedHosts: {
        format: "hostList",
        default: null,
        env: "KANTHORD_HTTP_ALLOWED_HOSTS",
      },
      allowedOrigins: {
        format: "originList",
        default: [],
        env: "KANTHORD_HTTP_ALLOWED_ORIGINS",
      },
      idempotency: {
        ttl: {
          format: "nonNegativeInteger",
          default: 300,
          env: "KANTHORD_HTTP_IDEMPOTENCY_TTL",
        },
        joinTimeout: {
          format: "nonNegativeInteger",
          default: 30,
          env: "KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT",
        },
        maxEntries: {
          format: "positiveInteger",
          default: 256,
          env: "KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES",
        },
        maxBytes: {
          format: "positiveInteger",
          default: 8388608,
          env: "KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES",
        },
      },
    },
    tools: {
      git: {
        format: "absolutePath",
        default: "/usr/bin/git",
        env: "KANTHORD_TOOLS_GIT",
      },
      ssh: {
        format: "absolutePath",
        default: "/usr/bin/ssh",
        env: "KANTHORD_TOOLS_SSH",
      },
      sshKeyscan: {
        format: "absolutePath",
        default: "/usr/bin/ssh-keyscan",
        env: "KANTHORD_TOOLS_SSH_KEYSCAN",
      },
    },
    attemptLimit: {
      format: "positiveInteger",
      default: 3,
      env: "KANTHORD_ATTEMPT_LIMIT",
    },
    leaseTtlMs: {
      format: "positiveInteger",
      default: 300000,
      env: "KANTHORD_LEASE_TTL_MS",
    },
  };
}

function normalizeAllowedHosts(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .map((s) => (typeof s === "string" ? s.trim() : s))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return [];
}

function normalizeAllowedOrigins(raw: unknown): unknown {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return raw;
}

export class ConvictConfig implements Config {
  load(input: LoadInput): Loaded {
    let candidates: readonly string[];
    let resolvedPath: string;

    if (
      input.explicitConfigPath !== undefined &&
      input.explicitConfigPath.length > 0
    ) {
      const explicitPath = path.resolve(input.cwd, input.explicitConfigPath);
      candidates = [explicitPath];
      resolvedPath = explicitPath;
      if (!fs.existsSync(resolvedPath)) {
        throw new ConfigError(
          "config-not-found",
          `no config file found; ${resolvedPath}`,
        );
      }
    } else {
      candidates = searchOrder({
        env: input.env,
        cwd: input.cwd,
        homeDir: input.homeDir ?? "/tmp",
        etcDir: input.etcDir ?? "/etc",
      });
      resolvedPath = candidates.find((p) => fs.existsSync(p)) ?? "";
      if (resolvedPath.length === 0) {
        throw new ConfigError(
          "config-not-found",
          `no config file found; searched: ${candidates.join(", ")}`,
        );
      }
    }

    let raw: string;
    try {
      raw = fs.readFileSync(resolvedPath, "utf-8");
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "ENOENT"
      ) {
        throw new ConfigError(
          "config-not-found",
          `no config file found; searched: ${candidates.join(", ")}`,
        );
      }
      throw err;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      throw new ConfigError(
        "config-invalid",
        `config file is not valid JSON (${resolvedPath}): ${(err as Error).message}`,
      );
    }

    convict.addFormats({
      nonEmptyString: { validate: nonEmptyString },
      hostList: { validate: hostList },
      originList: { validate: originList },
      positiveInteger: { validate: positiveInteger },
      nonNegativeInteger: { validate: nonNegativeInteger },
      absolutePath: { validate: absolutePath },
    });

    const config = convict(buildSchema(), { env: input.env });
    config.load(parsed);

    const idempotencyEnvIntegers: ReadonlyArray<readonly [string, string]> = [
      ["KANTHORD_HTTP_IDEMPOTENCY_TTL", "http.idempotency.ttl"],
      [
        "KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT",
        "http.idempotency.joinTimeout",
      ],
      ["KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES", "http.idempotency.maxEntries"],
      ["KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES", "http.idempotency.maxBytes"],
      ["KANTHORD_ATTEMPT_LIMIT", "attemptLimit"],
      ["KANTHORD_LEASE_TTL_MS", "leaseTtlMs"],
    ];
    for (const [envVar, configPath] of idempotencyEnvIntegers) {
      const rawValue = input.env[envVar];
      if (rawValue !== undefined) {
        config.set(configPath, parseEnvInteger(rawValue));
      }
    }

    const rawHosts = config.get("http.allowedHosts");
    const normalizedHosts = normalizeAllowedHosts(rawHosts);
    config.set("http.allowedHosts", normalizedHosts);

    config.set(
      "http.allowedOrigins",
      normalizeAllowedOrigins(config.get("http.allowedOrigins")),
    );

    if (input.homeOverride !== undefined && input.homeOverride.length > 0) {
      config.set("home", input.homeOverride);
    }

    try {
      config.validate({ allowed: "strict" });
    } catch (err: unknown) {
      throw new ConfigError("config-invalid", (err as Error).message);
    }

    const canonicalOrigins: string[] = [];
    for (const entry of config.get("http.allowedOrigins") as string[]) {
      const result = canonicalizeOrigin(entry);
      if (!result.ok) {
        throw new ConfigError(
          "config-invalid",
          `http.allowedOrigins entry ${JSON.stringify(entry)} is not a canonical origin (${result.reason})`,
        );
      }
      canonicalOrigins.push(result.origin);
    }
    config.set("http.allowedOrigins", canonicalOrigins);

    const masterKeyStr = config.get("masterKey") as string;
    const masterKeyFileStr = config.get("masterKeyFile") as string;
    const tokenStr = config.get("http.token") as string;
    const tokenFileStr = config.get("http.tokenFile") as string;

    let masterKey: Buffer;
    let masterKeyFileMode: number | undefined;
    let tokenFileMode: number | undefined;
    let masterKeyHandle: RestrictedSecretHandle | undefined;
    let tokenHandle: RestrictedSecretHandle | undefined;
    let bodyError: unknown = undefined;

    try {
      if (masterKeyFileStr.length > 0) {
        masterKeyHandle = openRestrictedSecretFile(
          masterKeyFileStr,
          "masterKeyFile",
        );
        masterKeyFileMode = masterKeyHandle.mode;
      }
      if (tokenFileStr.length > 0) {
        tokenHandle = openRestrictedSecretFile(tokenFileStr, "http.tokenFile");
        tokenFileMode = tokenHandle.mode;
      }

      const resolvedToken =
        tokenHandle !== undefined && (tokenHandle.mode & 0o777) === 0o600
          ? trimSingleTrailingNewline(tokenHandle.read())
          : tokenStr;

      assertStartable({
        masterKey: masterKeyStr,
        masterKeyFile: masterKeyFileStr,
        masterKeyFileMode,
        bind: config.get("http.bind") as string,
        token: tokenStr,
        tokenFile: tokenFileStr,
        tokenFileMode,
        resolvedToken,
        allowedOrigins: config.get("http.allowedOrigins") as string[],
        allowedHosts: normalizedHosts,
        port: config.get("http.port") as number,
      });

      if (tokenHandle !== undefined) {
        config.set("http.token", resolvedToken);
      }

      if (masterKeyStr.length > 0) {
        masterKey = Buffer.from(masterKeyStr, "base64");
      } else {
        const keyFileContent = masterKeyHandle!.read();
        masterKey = Buffer.from(keyFileContent.trim(), "base64");
      }
    } catch (err: unknown) {
      bodyError = err;
      throw err;
    } finally {
      let closeError: unknown;
      try {
        masterKeyHandle?.close();
      } catch (err: unknown) {
        closeError = err;
      }
      try {
        tokenHandle?.close();
      } catch (err: unknown) {
        if (closeError === undefined) {
          closeError = err;
        }
      }
      if (closeError !== undefined && bodyError === undefined) {
        throw closeError;
      }
    }

    if (masterKey.length !== 32) {
      throw new ConfigError(
        "config-invalid",
        `master key must be exactly 32 bytes, got ${masterKey.length}`,
      );
    }

    if (normalizedHosts === null) {
      config.set(
        "http.allowedHosts",
        deriveAllowedHosts({
          bind: config.get("http.bind") as string,
          port: config.get("http.port") as number,
        }),
      );
    }

    return {
      settings: {
        home: config.get("home") as string,
        actor: config.get("actor") as string,
        masterKey,
        http: {
          bind: config.get("http.bind") as string,
          port: config.get("http.port") as number,
          token: config.get("http.token") as string,
          allowedHosts: config.get("http.allowedHosts") as string[],
          allowedOrigins: config.get("http.allowedOrigins") as string[],
          idempotency: {
            ttl: config.get("http.idempotency.ttl") as number,
            joinTimeout: config.get("http.idempotency.joinTimeout") as number,
            maxEntries: config.get("http.idempotency.maxEntries") as number,
            maxBytes: config.get("http.idempotency.maxBytes") as number,
          },
        },
        tools: {
          git: config.get("tools.git") as string,
          ssh: config.get("tools.ssh") as string,
          sshKeyscan: config.get("tools.sshKeyscan") as string,
        },
        attemptLimit: config.get("attemptLimit") as number,
        leaseTtlMs: config.get("leaseTtlMs") as number,
      },
      discovery: {
        resolved: resolvedPath,
        searched: [...candidates],
      },
    };
  }
}
