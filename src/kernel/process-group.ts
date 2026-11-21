import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const SIGNAL_KILL = "SIGKILL";
const SIGNAL_STOP = "SIGSTOP";
const SIGNAL_TERM = "SIGTERM";
export const GROUP_GRACE_MS = 3000;
export const GROUP_MARKER_VARIABLE = "KANTHORD_PROCESS_GROUP_MARKER";
const NO_GROUPS = 0;
const SINGLE_FAILURE = 1;
export const FREEZE_PASSES_MAX = 8;
const FIRST_USER_PID = 1;
const PROCESS_ABSENT = "ESRCH";
const ENTRY_ABSENT = "ENOENT";
const LINUX = "linux";
const PROC_DIRECTORY = "/proc";
const STAT_PPID_FIELD = 1;
const STAT_GROUP_FIELD = 2;
const PS_COLUMNS = 4;
const PS_STATE_COLUMN = 3;
const ZOMBIE_STATE = "Z";
const STAT_STATE_FIELD = 0;
const PS_PATH = "/bin/ps";
const PS_ENVIRONMENT_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const PS_ENVIRONMENT_PID = 1;
const PS_ENVIRONMENT_GROUP = 2;
const PS_ENVIRONMENT_COMMAND = 3;
const ENVIRONMENT_SEPARATOR = "\0";
const UNREADABLE_CODES = ["ENOENT", "ESRCH", "EACCES", "EPERM"];
const STAT_NAME_GAP = 2;
const STAT_NAME_START = 0;

export interface ProcessRow {
  pid: number;
  ppid: number;
  group: number;
}

export function killProcessGroup(leader: number): void {
  assert.ok(Number.isSafeInteger(leader) && leader > FIRST_USER_PID);
  assert.ok(leader !== process.pid && leader !== process.ppid);
  process.kill(-leader, SIGNAL_KILL);
}

export interface ProcessEnvironment {
  pid: number;
  group: number;
  variables: readonly string[];
}

export interface ProcessSystem {
  readTable: () => ProcessRow[];
  readEnvironments: () => ProcessEnvironment[];
  signalGroup: (group: number, signal: NodeJS.Signals) => void;
}

export const SYSTEM_PROCESSES: ProcessSystem = {
  readTable: () => processTable(),
  readEnvironments: () => environmentTable(),
  signalGroup: (group, signal) => process.kill(-group, signal),
};

export interface ChildState {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
}

export function killChildTree(
  child: ChildState,
  system: ProcessSystem = SYSTEM_PROCESSES,
): void {
  if (child.exitCode === null && child.signalCode === null) {
    killProcessTree(child.pid, system);
    return;
  }
  assertLeader(child.pid);
  throwFailures(signalGroups([child.pid], SIGNAL_KILL, system));
}

export function killProcessTree(
  leader: number,
  system: ProcessSystem = SYSTEM_PROCESSES,
): void {
  assertLeader(leader);
  const stopped = new Set<number>();
  const failures: unknown[] = [];
  try {
    freezeTree(leader, system, stopped, failures);
  } catch (error) {
    failures.push(error);
  }
  const groups = stopped.size === NO_GROUPS ? [leader] : [...stopped];
  failures.push(...signalGroups(groups, SIGNAL_KILL, system));
  throwFailures(failures);
}

export function markedGroups(
  marker: string,
  system: ProcessSystem = SYSTEM_PROCESSES,
): number[] {
  assert.ok(marker);
  const variable = `${GROUP_MARKER_VARIABLE}=${marker}`;
  const own = ownGroups(system.readTable());
  const groups = system
    .readEnvironments()
    .filter((row) => row.variables.includes(variable))
    .map((row) => row.group)
    .filter((group) => group > FIRST_USER_PID && !own.has(group));
  return [...new Set(groups)];
}

export function endProcessGroups(
  groups: readonly number[],
  system: ProcessSystem = SYSTEM_PROCESSES,
): Promise<void> {
  for (const group of groups) assertLeader(group);
  if (groups.length === NO_GROUPS) return Promise.resolve();
  const live = [...liveGroups(groups, system)];
  if (live.length === NO_GROUPS) return Promise.resolve();
  const failures = signalGroups(live, SIGNAL_TERM, system);
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const remaining = [...liveGroups(live, system)];
        failures.push(...signalGroups(remaining, SIGNAL_KILL, system));
        throwFailures(failures);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, GROUP_GRACE_MS);
  });
}

export function liveGroups(
  groups: readonly number[],
  system: ProcessSystem = SYSTEM_PROCESSES,
): Set<number> {
  const listed = new Set(groups);
  return new Set(
    system
      .readTable()
      .map((row) => row.group)
      .filter((group) => listed.has(group)),
  );
}

function assertLeader(leader: number): void {
  assert.ok(Number.isSafeInteger(leader) && leader > FIRST_USER_PID);
  assert.ok(leader !== process.pid && leader !== process.ppid);
}

function freezeTree(
  leader: number,
  system: ProcessSystem,
  stopped: Set<number>,
  failures: unknown[],
): void {
  for (let pass = 0; pass < FREEZE_PASSES_MAX; pass += 1) {
    const fresh = freshGroups(leader, system.readTable(), stopped);
    if (fresh.length === NO_GROUPS) return;
    for (const group of fresh) stopped.add(group);
    failures.push(...signalGroups(fresh, SIGNAL_STOP, system));
  }
  const late = freshGroups(leader, system.readTable(), stopped);
  if (late.length === NO_GROUPS) return;
  for (const group of late) stopped.add(group);
  failures.push(
    new Error(
      `the process tree kept forking after ${FREEZE_PASSES_MAX} passes`,
    ),
  );
}

function freshGroups(
  leader: number,
  rows: readonly ProcessRow[],
  stopped: ReadonlySet<number>,
): number[] {
  const own = ownGroups(rows);
  const found = [leader, ...descendantGroups(leader, rows)].filter(
    (group) => group > FIRST_USER_PID && !own.has(group) && !stopped.has(group),
  );
  return [...new Set(found)];
}

function ownGroups(rows: readonly ProcessRow[]): Set<number> {
  return new Set(
    rows
      .filter((row) => row.pid === process.pid || row.pid === process.ppid)
      .map((row) => row.group),
  );
}

function signalGroups(
  groups: readonly number[],
  signal: NodeJS.Signals,
  system: ProcessSystem,
): unknown[] {
  return groups.flatMap((group) => {
    try {
      system.signalGroup(group, signal);
      return [];
    } catch (error) {
      return isCode(error, PROCESS_ABSENT) ? [] : [error];
    }
  });
}

function throwFailures(failures: readonly unknown[]): void {
  if (failures.length === NO_GROUPS) return;
  if (failures.length === SINGLE_FAILURE) throw failures[0];
  throw new AggregateError(failures, "the kill of a process tree failed");
}

function descendantGroups(
  leader: number,
  rows: readonly ProcessRow[],
): number[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows)
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const groups: number[] = [];
  const seen = new Set<number>([leader]);
  const pending = [leader];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop())
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      groups.push(child.group);
      pending.push(child.pid);
    }
  return groups;
}

function processTable(): ProcessRow[] {
  return process.platform === LINUX ? procTable() : psTable();
}

function procTable(): ProcessRow[] {
  return readdirSync(PROC_DIRECTORY)
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      const stat = procStat(name);
      return stat === null || zombieStat(stat) ? [] : [procStatRow(stat)];
    });
}

function zombieStat(stat: string): boolean {
  const name = stat.lastIndexOf(")");
  assert.ok(name > STAT_NAME_START);
  const fields = stat.slice(name + STAT_NAME_GAP).split(" ");
  return fields[STAT_STATE_FIELD] === ZOMBIE_STATE;
}

export function procStatRow(stat: string): ProcessRow {
  const name = stat.lastIndexOf(")");
  assert.ok(name > STAT_NAME_START);
  const fields = stat.slice(name + STAT_NAME_GAP).split(" ");
  const row = {
    pid: Number.parseInt(stat, 10),
    ppid: Number(fields[STAT_PPID_FIELD]),
    group: Number(fields[STAT_GROUP_FIELD]),
  };
  assert.ok(Object.values(row).every(Number.isSafeInteger));
  return row;
}

function procStat(pid: string): string | null {
  try {
    return readFileSync(`${PROC_DIRECTORY}/${pid}/stat`, "utf8");
  } catch (error) {
    if (isCode(error, ENTRY_ABSENT) || isCode(error, PROCESS_ABSENT))
      return null;
    throw error;
  }
}

function environmentTable(): ProcessEnvironment[] {
  return process.platform === LINUX ? procEnvironments() : psEnvironments();
}

function procEnvironments(): ProcessEnvironment[] {
  return readdirSync(PROC_DIRECTORY)
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      const stat = procStat(name);
      const environ = stat === null ? null : procEnviron(name);
      if (stat === null || environ === null) return [];
      const { pid, group } = procStatRow(stat);
      return [{ pid, group, variables: environ.split(ENVIRONMENT_SEPARATOR) }];
    });
}

function procEnviron(pid: string): string | null {
  try {
    return readFileSync(`${PROC_DIRECTORY}/${pid}/environ`, "utf8");
  } catch (error) {
    if (UNREADABLE_CODES.some((code) => isCode(error, code))) return null;
    throw error;
  }
}

function psEnvironments(): ProcessEnvironment[] {
  const output = execFileSync(
    PS_PATH,
    ["-E", "-ww", "-A", "-o", "pid=,pgid=,command="],
    { encoding: "utf8" },
  );
  return output.split("\n").flatMap((line) => {
    const columns = PS_ENVIRONMENT_LINE.exec(line);
    if (columns === null) return [];
    return [
      {
        pid: Number(columns[PS_ENVIRONMENT_PID]),
        group: Number(columns[PS_ENVIRONMENT_GROUP]),
        variables: columns[PS_ENVIRONMENT_COMMAND]!.split(/\s+/),
      },
    ];
  });
}

function psTable(): ProcessRow[] {
  const output = execFileSync(PS_PATH, ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length === PS_COLUMNS)
    .filter((columns) => !columns[PS_STATE_COLUMN]!.startsWith(ZOMBIE_STATE))
    .map(([pid, ppid, group]) => {
      assert.ok(
        Number.isSafeInteger(Number(pid)) &&
          Number.isSafeInteger(Number(group)),
      );
      return { pid: Number(pid), ppid: Number(ppid), group: Number(group) };
    });
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
