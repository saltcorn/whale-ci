import { spawn } from "node:child_process";

/**
 * Receives chunks of combined stdout/stderr from a container-tool command, so a
 * step's output can be captured for the HTML report. When no sink is given the
 * command streams straight to the terminal instead.
 */
export type OutputSink = (chunk: string) => void;

/** Options for {@link execTool}. */
export interface ExecToolOptions {
  /** Resolve with the exit code instead of rejecting on non-zero. */
  allowNonZero?: boolean;
  /** Suppress the terminal echo (the sink, if any, still receives output). */
  quiet?: boolean;
  /** Forward combined stdout/stderr to this sink (for the report). */
  sink?: OutputSink;
  /** Text to feed to the child's stdin (e.g. a Dockerfile fed in on `-f -`). */
  input?: string;
}

/** Outcome of a host shell command run with {@link runShell}. */
export interface ShellResult {
  /** The command's exit code. */
  code: number;
  /** Everything the command wrote to stdout (stderr is discarded). */
  stdout: string;
}

/**
 * Run a command on the host through `bash -c`, capturing its stdout. Used for
 * step `only-if` checks (where only the exit code matters) and for `$(...)`
 * push tags (where the output becomes the tag). Never echoes to the terminal.
 */
export function runShell(command: string): Promise<ShellResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout });
    });
  });
}

/**
 * Spawn `binary` with the given args. With a `sink` the output is piped and
 * forwarded to the sink (for the report), and also echoed to the terminal
 * unless `quiet`. Without a sink, stdio is inherited so the tool streams
 * directly — or discarded entirely when `quiet`. Resolves with the exit code;
 * rejects on non-zero unless `allowNonZero` is set.
 */
export function execTool(
  binary: string,
  args: string[],
  opts: ExecToolOptions = {},
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const streamMode = opts.sink ? "pipe" : opts.quiet ? "ignore" : "inherit";
    // Pipe stdin only when there is input to write; otherwise leave it as the
    // shared stream mode.
    const stdin = opts.input !== undefined ? "pipe" : streamMode;
    const child = spawn(binary, args, {
      stdio: [stdin, streamMode, streamMode],
    });
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input);
    }

    if (opts.sink) {
      const tee = (
        stream: NodeJS.ReadableStream | null,
        out: NodeJS.WriteStream,
      ): void => {
        stream?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (!opts.quiet) out.write(text);
          opts.sink!(text);
        });
      };
      tee(child.stdout, process.stdout);
      tee(child.stderr, process.stderr);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(
          new Error(`${binary} ${args.join(" ")} exited with ${exitCode}`),
        );
      } else {
        resolvePromise(exitCode);
      }
    });
  });
}
