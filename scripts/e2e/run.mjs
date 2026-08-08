#!/usr/bin/env node
import { main } from "./lib/main.ts";

process.exitCode = await main(process.argv.slice(2));
