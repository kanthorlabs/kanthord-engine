import { spawnSupervised } from "./src/services/git/launcher.ts";
import { stopChild } from "./src/services/git/child.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function trial() {
  const dir = mkdtempSync(join(tmpdir(), "trap-"));
  const script = join(dir, "ignore-term.sh");
  writeFileSync(script, '#!/bin/sh\ntrap "" TERM\nexec /bin/sleep 30\n', {
    mode: 0o700,
  });
  const child = spawnSupervised({
    command: script,
    args: [],
    env: { PATH: "/usr/bin:/bin" },
    cwd: dir,
    pidFile: join(dir, "git.pid"),
  });
  const started = Date.now();
  await stopChild({ pid: child.pid, graceMs: 50 });
  const elapsed = Date.now() - started;
  rmSync(dir, { recursive: true, force: true });
  return elapsed;
}

let fails = 0;
const n = 60;
const times = [];
for (let i = 0; i < n; i++) {
  const e = await trial();
  times.push(e);
  if (e < 50) fails++;
}
console.log(
  `trials=${n} FAILURES(elapsed<50ms, "SIGKILL path must run" would fire)=${fails}`,
);
console.log(`min=${Math.min(...times)}ms  max=${Math.max(...times)}ms`);
if (fails)
  console.log(
    "failing elapsed values:",
    times.filter((t) => t < 50).join(", "),
  );
