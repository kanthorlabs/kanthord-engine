import assert from "node:assert/strict";

const SIGNAL_KILL = "SIGKILL";
const FIRST_USER_PID = 1;

export function killProcessGroup(leader: number): void {
  assert.ok(Number.isSafeInteger(leader) && leader > FIRST_USER_PID);
  process.kill(-leader, SIGNAL_KILL);
}
