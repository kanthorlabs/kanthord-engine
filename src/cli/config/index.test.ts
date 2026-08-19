import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { configCommand } from "./index.ts";

describe("src/cli/config/index.test", () => {
  it("the config help lists the daemon configuration search order", () => {
    let help = "";
    const command = configCommand(new Command());
    command.configureOutput({ writeOut: (text) => (help += text) });
    command.outputHelp();

    assert.ok(
      help.includes("Configuration search order at daemon start:"),
      help,
    );
    assert.ok(help.includes("1. the --config <path> file"), help);
    assert.ok(help.includes("2. $KANTHORD_CONFIG"), help);
    assert.ok(help.includes("3. ./kanthord.config.json"), help);
    assert.ok(help.includes("4. $XDG_CONFIG_HOME/kanthord/config.json"), help);
    assert.ok(help.includes("5. /etc/kanthord/config.json"), help);
    assert.ok(
      help.includes("The daemon loads the first candidate that exists."),
      help,
    );
  });

  it("a second call reuses the registered config command", () => {
    const program = new Command();

    const first = configCommand(program);
    const second = configCommand(program);

    assert.equal(first, second);
    assert.equal(
      program.commands.filter((command) => command.name() === "config").length,
      1,
    );
  });
});
