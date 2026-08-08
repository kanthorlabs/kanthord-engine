import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(raw);
  const path = join(payload.home, "kanthord.config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  chmodSync(path, 0o600);
});
