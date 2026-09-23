#!/usr/bin/env node

// Keep this gate parseable on runtimes older than the supported floor.
const version = process.versions.node.split(".").map(Number);
if (version[0] !== 24 || version[1] < 15) {
  process.stderr.write("kanthord requires Node.js >=24.15.0 <25.\n");
  process.exit(1);
}
import("../dist/main.js").catch(function () {
  process.stderr.write(
    "kanthord could not load its application. Build the package first.\n",
  );
  process.exit(1);
});
