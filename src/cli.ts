#!/usr/bin/env node
import { loadConfig } from "../lib/config.ts";
import { runPipeline } from "../lib/runner.ts";
import { ConfigError } from "../lib/types.ts";

const HELP = `dockerci - continuous integration with linked docker containers

Usage:
  npx dockerci <config.yml>
  npx dockerci --help

Runs the CI pipeline described by the YAML config file. Each section defines a
container built from a Dockerfile or pulled by image name. Images are built in
parallel where dependencies allow; if any build or command fails the run exits
with code 1. All started containers are stopped when the run finishes.`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  if (args.length === 0) {
    console.error("Error: no config file given\n");
    console.error(HELP);
    return 1;
  }
  if (args.length > 1) {
    console.error("Error: expected a single config file argument\n");
    console.error(HELP);
    return 1;
  }

  const file = args[0]!;
  try {
    const config = await loadConfig(file);
    const ok = await runPipeline(config);
    return ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
