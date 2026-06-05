#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.ts";
import { renderReport } from "../lib/report.ts";
import { runPipeline } from "../lib/runner.ts";
import { ConfigError } from "../lib/types.ts";

const HELP = `dockerci - continuous integration with linked docker containers

Usage:
  npx dock-ci [options] <config.yml>

Options:
  -o, --output <file>   Write an HTML report of every step (build output,
                        pass/fail and duration) to <file>.
  -h, --help            Show this help.

Runs the CI pipeline described by the YAML config file. Each section defines a
container built from a Dockerfile or pulled by image name. Images are built in
parallel where dependencies allow; if any build or command fails the run exits
with code 1. All started containers are stopped when the run finishes.`;

interface ParsedArgs {
  help: boolean;
  output?: string;
  configFile?: string;
  error?: string;
}

/** Parse argv into the config file and options. */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "-o" || arg === "--output") {
      const value = args[++i];
      if (value === undefined) {
        return { ...parsed, error: `Missing value for ${arg}` };
      }
      parsed.output = value;
    } else if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
    } else if (arg.startsWith("-o") && arg.length > 2) {
      parsed.output = arg.slice(2);
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `Unknown option: ${arg}` };
    } else if (parsed.configFile === undefined) {
      parsed.configFile = arg;
    } else {
      return { ...parsed, error: "Expected a single config file argument" };
    }
  }

  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.error !== undefined) {
    console.error(`Error: ${args.error}\n`);
    console.error(HELP);
    return 1;
  }
  if (args.configFile === undefined) {
    console.error("Error: no config file given\n");
    console.error(HELP);
    return 1;
  }

  try {
    const config = await loadConfig(args.configFile);
    const result = await runPipeline(config, {
      captureOutput: args.output !== undefined,
    });

    if (args.output !== undefined) {
      const html = renderReport(result.steps, {
        ok: result.ok,
        configFile: args.configFile,
      });
      await writeFile(args.output, html, "utf8");
      console.error(`Report written to ${args.output}`);
    }

    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/**
 * True when this module is the process entry point (rather than imported, e.g.
 * by tests). Portable across Node 22+ — `import.meta.main` only exists on Node
 * 24.2+. `realpathSync` resolves the npx bin symlink so it matches the module
 * URL.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Only run when invoked as the CLI entry point, so the module can also be
// imported (e.g. by tests) without executing the pipeline.
if (isEntryPoint()) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
