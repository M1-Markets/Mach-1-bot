#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const launcher = path.resolve(
  __dirname,
  "..",
  "packages",
  "mach1_bot",
  "mach-one-bot",
);

const result = spawnSync(
  process.execPath,
  [launcher, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, MACH1_INVOCATION_CWD: process.cwd() },
  },
);

process.exit(result.status ?? 1);
