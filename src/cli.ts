#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { binary, command, option, optional, positional, run, string } from "cmd-ts";
import { loadConfig } from "../lib/config.ts";
import { renderReport } from "../lib/report.ts";
import { runPipeline } from "../lib/runner.ts";
import { ConfigError } from "../lib/types.ts";

/**
 * The dock-ci command. cmd-ts handles `--help`/`-h` and argument validation
 * (missing config file, unknown options) for us, exiting with the right code
 * and message. The handler runs the pipeline and returns the process exit code.
 */
export const app = command({
  name: "dock-ci",
  description:
    "Continuous integration with linked docker containers. Builds the images " +
    "described by the YAML config (in parallel where dependencies allow), runs " +
    "each step's command, and stops every container when the run finishes. " +
    "Exits non-zero if any build or command fails.",
  args: {
    output: option({
      type: optional(string),
      long: "output",
      short: "o",
      description:
        "Write a self-contained HTML report (per-step output, pass/fail and " +
        "duration) to this file.",
    }),
    configFile: positional({
      type: string,
      displayName: "config.yml",
      description: "Path to the YAML pipeline configuration file.",
    }),
  },
  handler: ({ output, configFile }) => runCli(configFile, output),
});

/**
 * Load the config, run the pipeline and (optionally) write the HTML report.
 * Returns the process exit code: 0 on success, 1 on failure, 130 if interrupted.
 */
async function runCli(configFile: string, output?: string): Promise<number> {
  try {
    const config = await loadConfig(configFile);

    // On Ctrl-C, abort the run so every container is stopped before exiting; a
    // second Ctrl-C force-quits in case teardown itself hangs.
    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = (): void => {
      interrupts += 1;
      if (interrupts === 1) {
        console.error(
          "\nInterrupted — stopping containers (press Ctrl-C again to force quit)...",
        );
        controller.abort();
      } else {
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);

    let result;
    try {
      result = await runPipeline(config, {
        captureOutput: output !== undefined,
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    if (output !== undefined) {
      const html = renderReport(result.steps, {
        ok: result.ok,
        configFile,
      });
      await writeFile(output, html, "utf8");
      console.error(`Report written to ${output}`);
    }

    // 130 is the conventional exit code for a SIGINT-interrupted process.
    if (controller.signal.aborted) return 130;
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
// imported (e.g. by tests) without executing the pipeline. cmd-ts's `run`
// handles `--help` and parse errors by printing and exiting directly; the
// handler's resolved value is the exit code for a successful parse.
if (isEntryPoint()) {
  run(binary(app), process.argv).then(
    async (code) => {
      process.exitCode = await code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
