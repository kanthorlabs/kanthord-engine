import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const SIGNAL_KILL = "SIGKILL";
const FIRST_USER_PID = 1;
const PROCESS_ABSENT = "ESRCH";
const ENTRY_ABSENT = "ENOENT";
const LINUX = "linux";
const PROC_DIRECTORY = "/proc";
const STAT_PPID_FIELD = 1;
const STAT_GROUP_FIELD = 2;
const PS_COLUMNS = 3;
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

export function killProcessTree(leader: number): void {
  assert.ok(Number.isSafeInteger(leader) && leader > FIRST_USER_PID);
  assert.ok(leader !== process.pid && leader !== process.ppid);
  const rows = tableOrLeaderKill(leader);
  const own = new Set(
    rows
      .filter((row) => row.pid === process.pid || row.pid === process.ppid)
      .map((row) => row.group),
  );
  const groups = [leader, ...descendantGroups(leader, rows)].filter(
    (group) => group > FIRST_USER_PID && !own.has(group),
  );
  const [failure] = [...new Set(groups)].flatMap((group) => killGroup(group));
  if (failure !== undefined) throw failure;
}

function tableOrLeaderKill(leader: number): ProcessRow[] {
  try {
    return processTable();
  } catch (error) {
    killGroup(leader);
    throw error;
  }
}

function killGroup(group: number): unknown[] {
  try {
    process.kill(-group, SIGNAL_KILL);
    return [];
  } catch (error) {
    if (isCode(error, PROCESS_ABSENT)) return [];
    return [error];
  }
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
      return stat === null ? [] : [procStatRow(stat)];
    });
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

function psTable(): ProcessRow[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((columns) => columns.length === PS_COLUMNS)
    .map(([pid, ppid, group]) => {
      assert.ok(Number.isSafeInteger(pid) && Number.isSafeInteger(group));
      return { pid: pid!, ppid: ppid!, group: group! };
    });
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
