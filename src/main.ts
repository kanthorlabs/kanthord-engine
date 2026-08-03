#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { statfsSync } from "node:fs";
import { Command } from "commander";
import { ulid } from "ulid";

import { KANTHORD_VERSION } from "./domain/version.ts";
import { ConvictConfig } from "./services/config/convict.ts";
import { ConfigError } from "./services/config/index.ts";
import { StatfsProbe } from "./services/home-lock/statfs-probe.ts";
import { SqliteHomeLock } from "./services/home-lock/sqlite.ts";
import { HomeLockError } from "./services/home-lock/index.ts";

const program = new Command()
  .name("kanthord")
  .version(KANTHORD_VERSION)
  .option("--config <path>", "path to the configuration file")
  .option("--home <path>", "override the configured daemon home");

program
  .command("serve")
  .description("run the daemon")
  .action(async () => {
    const options = program.opts();
    try {
      const { settings } = new ConvictConfig().load({
        explicitConfigPath: options.config,
        homeOverride: options.home,
        env: process.env,
        cwd: process.cwd(),
        homeDir: homedir(),
        etcDir: "/etc",
      });
      const probe = new StatfsProbe({
        platform: process.platform,
        statfs: statfsSync,
      });
      const held = new SqliteHomeLock({ probe }).acquire({
        home: settings.home,
      });
      held.publishIdentity({
        version: 1,
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        instanceId: ulid(),
      });
      held.sweepRefLocks();
      process.stdout.write("kanthord: ready\n");
      setInterval(() => {}, 1 << 30);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof HomeLockError) {
        process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

await program.parseAsync(process.argv);
