#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

try {
  const result = await runCli(process.argv.slice(2));
  if (result) process.stdout.write(`${result}\n`);
} catch (error) {
  process.stderr.write(`krkrtools: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
