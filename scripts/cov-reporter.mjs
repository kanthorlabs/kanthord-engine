import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ["--test", "--test-timeout=60000", "--experimental-test-coverage", ...args],
  { stdio: ["inherit", "pipe", "inherit"] },
);

let inCovReport = false;
let allFilesLine = "";

const rl = createInterface({ input: child.stdout, terminal: false });

rl.on("line", (line) => {
  if (line.includes("start of coverage report")) {
    inCovReport = true;
    return;
  }
  if (line.includes("end of coverage report")) {
    inCovReport = false;
    if (allFilesLine) {
      const nums = allFilesLine.match(/\d+\.\d+/g) ?? [];
      const [lines = NaN, branches = NaN, functions = NaN] = nums.map(Number);
      process.stdout.write(JSON.stringify({ lines, branches, functions }));
    }
    return;
  }
  if (inCovReport) {
    if (line.includes("all files")) allFilesLine = line;
    return;
  }
  process.stdout.write(line + "\n");
});

child.on("exit", (code) => process.exit(code ?? 0));
