import type { Ledger } from "../resources.ts";
import type { CommandSink, CommandRecord } from "../command.ts";
import type { ScenarioId } from "../tag.ts";

export type ScenarioContext = Readonly<{
  tag: string;
  scenarioId: ScenarioId;
  bundleDirectory: string;
  take: Ledger["take"];
  sink: CommandSink;
  assert(name: string, expected: unknown, actual: unknown): void;
  noteObject?(key: string, id: string): void;
  attachLog?(name: string, text: string): void;
  logs?(): Readonly<Record<string, string>>;
  printedLines?(): readonly string[];
  commandsRecorded?(): readonly CommandRecord[];
  daemonHost: string | null;
  clientHost: string | null;
}>;
