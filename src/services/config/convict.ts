/// <reference path="./convict.d.ts" />
import fs from "node:fs";
import path from "node:path";
import convict from "convict";

import type { Config, LoadInput, Loaded } from "./index.ts";
import { ConfigError } from "./index.ts";
import { searchOrder } from "./search-order.ts";
import { assertStartable } from "./refusals.ts";

function nonEmptyString(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("must be a non-empty string");
  }
}

function hostList(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("must be a non-empty array");
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
      port: { format: "port", default: null, env: "KANTHORD_HTTP_PORT" },
      token: { format: "String", default: "", env: "KANTHORD_HTTP_TOKEN" },
      allowedHosts: {
        format: "hostList",
        default: null,
        env: "KANTHORD_HTTP_ALLOWED_HOSTS",
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
  };
}

function normalizeAllowedHosts(raw: unknown): string[] {
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
      positiveInteger: { validate: positiveInteger },
      absolutePath: { validate: absolutePath },
    });

    const config = convict(buildSchema(), { env: input.env });
    config.load(parsed);

    const rawHosts = config.get("http.allowedHosts");
    config.set("http.allowedHosts", normalizeAllowedHosts(rawHosts));

    if (input.homeOverride !== undefined && input.homeOverride.length > 0) {
      config.set("home", input.homeOverride);
    }

    try {
      config.validate({ allowed: "strict" });
    } catch (err: unknown) {
      throw new ConfigError("config-invalid", (err as Error).message);
    }

    const masterKeyStr = config.get("masterKey") as string;
    const masterKeyFileStr = config.get("masterKeyFile") as string;
    let masterKeyFileMode: number | undefined;

    if (masterKeyFileStr.length > 0) {
      try {
        const stat = fs.statSync(masterKeyFileStr);
        masterKeyFileMode = stat.mode;
      } catch (err: unknown) {
        if (
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === "ENOENT"
        ) {
          throw new ConfigError(
            "config-invalid",
            `masterKeyFile not found: ${masterKeyFileStr}`,
          );
        }
        throw err;
      }
    }

    assertStartable({
      masterKey: masterKeyStr,
      masterKeyFile: masterKeyFileStr,
      masterKeyFileMode,
      bind: config.get("http.bind") as string,
      token: config.get("http.token") as string,
    });

    let masterKey: Buffer;
    if (masterKeyStr.length > 0) {
      masterKey = Buffer.from(masterKeyStr, "base64");
    } else {
      const keyFileContent = fs.readFileSync(masterKeyFileStr, "utf-8");
      masterKey = Buffer.from(keyFileContent.trim(), "base64");
    }

    if (masterKey.length !== 32) {
      throw new ConfigError(
        "config-invalid",
        `master key must be exactly 32 bytes, got ${masterKey.length}`,
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
        },
        tools: {
          git: config.get("tools.git") as string,
          ssh: config.get("tools.ssh") as string,
          sshKeyscan: config.get("tools.sshKeyscan") as string,
        },
        attemptLimit: config.get("attemptLimit") as number,
      },
      discovery: {
        resolved: resolvedPath,
        searched: [...candidates],
      },
    };
  }
}
