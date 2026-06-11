import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execTool, type ExecToolOptions, type OutputSink } from "./proc.ts";
import type { Step } from "./types.ts";

export type { OutputSink };

/** Options describing how to launch a step's container. */
export interface RunOptions {
  /** Image reference to run. */
  image: string;
  /** Container name. */
  name: string;
  /** Network to attach to. */
  network: string;
  /** Network alias other containers use to reach this one (the step name). */
  alias: string;
  /** Command to run inside the container, already split into argv. */
  command?: string[];
  /** Environment variables, as `KEY=value` strings. */
  environment: string[];
  ports: number[];
  /**
   * When true the container is left in place after it exits (no `--rm`) so its
   * filesystem can be committed; the caller is then responsible for removing it.
   * Defaults to removing the container automatically.
   */
  keep?: boolean;
}

/** Handle for a live log follower started by {@link DockerClient.followLogs}. */
export interface LogFollower {
  /**
   * Resolves once the readiness marker has appeared (immediately when no marker
   * was requested); rejects if the container's output ends before it appears.
   */
  ready: Promise<void>;
  /** Stop following and resolve once the follower has drained and exited. */
  stop(): Promise<void>;
}

/**
 * The docker operations the runner needs. Abstracted behind an interface so
 * the orchestration can be tested without a real docker daemon.
 *
 * Methods that produce user-facing output take an optional `sink`; when present
 * the output is forwarded to the sink for the report. By default the output is
 * also streamed to the terminal; pass `quiet` to suppress that echo (the sink,
 * if any, still receives it).
 */
export interface DockerClient {
  createNetwork(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /**
   * Build an image from a Dockerfile. When `baseImage` is given, the build's
   * first `FROM` instruction is rewritten to use that image (so a step can build
   * on top of another step's generated image); the rewritten Dockerfile is fed
   * to docker on stdin and the original file is left untouched.
   */
  build(
    tag: string,
    dockerfile: string,
    context: string,
    sink?: OutputSink,
    quiet?: boolean,
    baseImage?: string,
  ): Promise<void>;
  /** Pull an image from a registry. */
  pull(image: string, sink?: OutputSink, quiet?: boolean): Promise<void>;
  /** Run a container to completion, resolving with its exit code. */
  run(options: RunOptions, sink?: OutputSink, quiet?: boolean): Promise<number>;
  /** Start a container detached, resolving once it is running. */
  startDetached(
    options: RunOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<void>;
  /**
   * Start following a container's output live, streaming each chunk to the
   * terminal (unless `quiet`) and (if given) the sink as it arrives — so a
   * service's output is not deferred until the step ends. When `readyNeedle` is
   * supplied the returned handle's `ready` promise resolves when that string
   * appears.
   */
  followLogs(
    name: string,
    sink?: OutputSink,
    readyNeedle?: string,
    quiet?: boolean,
  ): LogFollower;
  /** Commit a stopped container's filesystem to a new image tag. */
  commit(container: string, tag: string): Promise<void>;
  /** Remove an image by tag; never rejects. */
  removeImage(tag: string): Promise<void>;
  /** Stop and remove a container by name; never rejects. */
  stop(name: string): Promise<void>;
}

/**
 * The image tag used for a step. A built step's image is tagged
 * `dockerci/<name>:<runId>`, where `runId` is unique to this pipeline run, so
 * concurrent runs (e.g. several webhook pushes) never share or clobber each
 * other's images. A step pulling a plain `image` uses that image name as-is.
 */
export function imageTag(step: Step, runId: string): string {
  // An `image` that names another build step runs that step's generated image.
  if (step.imageFrom !== undefined) {
    return builtImageTag(step.imageFrom, runId);
  }
  if (step.image !== undefined) {
    return step.image;
  }
  return builtImageTag(step.name, runId);
}

/** The per-run image tag a build step's `name` produces. */
function builtImageTag(name: string, runId: string): string {
  return `dockerci/${name}:${runId}`;
}

/**
 * The image named by the first `FROM` instruction in a Dockerfile, or undefined
 * if there is none. Blank lines and comments are skipped, `--platform=` (and
 * other) flags are ignored, and any `AS <stage>` suffix is dropped — only the
 * image reference is returned.
 */
export function firstFromImage(dockerfile: string): string | undefined {
  for (const raw of dockerfile.split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/);
    if (tokens[0]?.toUpperCase() !== "FROM") continue;
    let i = 1;
    while (tokens[i]?.startsWith("--")) i++; // skip flags such as --platform=...
    return tokens[i];
  }
  return undefined;
}

/**
 * Rewrite the image of the first `FROM` instruction in a Dockerfile to
 * `image`, preserving the instruction's flags and any `AS <stage>` suffix and
 * leaving the rest of the file unchanged. If there is no `FROM`, the text is
 * returned untouched.
 */
export function rewriteBaseImage(dockerfile: string, image: string): string {
  const lines = dockerfile.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Capture: leading "FROM " + flags, the image token, then the remainder.
    const match = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i.exec(lines[i]!);
    if (match === null) continue;
    lines[i] = `${match[1]}${image}${match[3]}`;
    return lines.join("\n");
  }
  return dockerfile;
}

/**
 * Split a `command:` string into argv, honouring shell-style quoting so that
 * arguments containing spaces (e.g. `--command='create extension "x";'`) stay
 * intact. Single quotes are literal, double quotes allow backslash escapes, and
 * a bare backslash escapes the next character. Empty / missing -> undefined.
 */
export function splitCommand(command: string | undefined): string[] | undefined {
  if (command === undefined) return undefined;
  const parts: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i]!;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]!;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) parts.push(current);
      current = "";
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote !== undefined) {
    throw new Error(`Unterminated ${quote === "'" ? "single" : "double"} quote in command: ${command}`);
  }
  if (hasToken) parts.push(current);
  return parts.length > 0 ? parts : undefined;
}

/** Build the argv for `docker build`. */
export function buildArgs(
  tag: string,
  dockerfile: string,
  context: string,
): string[] {
  return ["build", "-t", tag, "-f", dockerfile, context];
}

/** Build the argv for `docker run`, shared by foreground and detached runs. */
export function runArgs(options: RunOptions, detached: boolean): string[] {
  const args = ["run"];
  if (!options.keep) args.push("--rm");
  args.push(detached ? "-d" : "-i");
  args.push("--name", options.name);
  args.push("--network", options.network);
  args.push("--network-alias", options.alias);
  for (const env of options.environment) {
    args.push("-e", env);
  }
  for (const port of options.ports) {
    args.push("-p", `${port}:${port}`);
  }
  args.push(options.image);
  if (options.command) {
    args.push(...options.command);
  }
  return args;
}

/** A DockerClient that shells out to the real `docker` binary. */
export class CliDockerClient implements DockerClient {
  readonly #docker: string;

  constructor(docker = "docker") {
    this.#docker = docker;
  }

  async createNetwork(name: string): Promise<void> {
    await this.#exec(["network", "create", name]);
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.#exec(["network", "rm", name], { quiet: true });
    } catch {
      // Best effort during teardown.
    }
  }

  async build(
    tag: string,
    dockerfile: string,
    context: string,
    sink?: OutputSink,
    quiet?: boolean,
    baseImage?: string,
  ): Promise<void> {
    const dockerfilePath = resolve(context, dockerfile);
    if (baseImage === undefined) {
      await this.#exec(buildArgs(tag, dockerfilePath, resolve(context)), {
        sink,
        quiet,
      });
      return;
    }
    // Build on top of another step's generated image: rewrite the first FROM to
    // point at it and feed the rewritten Dockerfile in on stdin (`-f -`), so the
    // original file on disk is never modified — safe under parallel builds.
    const rewritten = rewriteBaseImage(
      await readFile(dockerfilePath, "utf8"),
      baseImage,
    );
    await this.#exec(["build", "-t", tag, "-f", "-", resolve(context)], {
      sink,
      quiet,
      input: rewritten,
    });
  }

  async pull(image: string, sink?: OutputSink, quiet?: boolean): Promise<void> {
    await this.#exec(["pull", image], { sink, quiet });
  }

  async run(
    options: RunOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<number> {
    return await this.#exec(runArgs(options, false), {
      allowNonZero: true,
      sink,
      quiet,
    });
  }

  async startDetached(
    options: RunOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<void> {
    await this.#exec(runArgs(options, true), { sink, quiet });
  }

  /**
   * Follow `docker logs -f` (which replays existing output before following, so
   * nothing printed before we attach is missed) and stream every chunk to the
   * terminal (unless `quiet`) and the sink as it arrives. When `readyNeedle` is
   * set, `ready` resolves the moment it appears; if the container stops first
   * the stream ends and `ready` rejects, so a service that dies before
   * signalling readiness fails the step.
   */
  followLogs(
    name: string,
    sink?: OutputSink,
    readyNeedle?: string,
    quiet?: boolean,
  ): LogFollower {
    const child = spawn(this.#docker, ["logs", "-f", name], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    let readySettled = readyNeedle === undefined;
    if (readySettled) resolveReady();

    let buffer = "";
    const onChunk = (chunk: Buffer, out: NodeJS.WriteStream): void => {
      const text = chunk.toString();
      if (!quiet) out.write(text);
      sink?.(text);
      if (readySettled) return;
      buffer += text;
      if (buffer.includes(readyNeedle!)) {
        readySettled = true;
        resolveReady();
      } else if (buffer.length > readyNeedle!.length) {
        // Keep a tail long enough to catch a needle split across two chunks.
        buffer = buffer.slice(-readyNeedle!.length);
      }
    };
    child.stdout?.on("data", (c: Buffer) => onChunk(c, process.stdout));
    child.stderr?.on("data", (c: Buffer) => onChunk(c, process.stderr));

    const done = new Promise<void>((resolveDone) => {
      const finish = (): void => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(
            new Error(
              `Container ${name} stopped before "${readyNeedle}" appeared in its output`,
            ),
          );
        }
        resolveDone();
      };
      child.on("error", finish);
      child.on("close", finish);
    });

    return {
      ready,
      stop: async () => {
        child.kill();
        await done;
      },
    };
  }

  async commit(container: string, tag: string): Promise<void> {
    await this.#exec(["commit", container, tag], { quiet: true });
  }

  async removeImage(tag: string): Promise<void> {
    try {
      await this.#exec(["image", "rm", "-f", tag], { quiet: true });
    } catch {
      // Best effort while cleaning up intermediate images.
    }
  }

  async stop(name: string): Promise<void> {
    try {
      // Foreground jobs run with `--rm` may already be gone; stay quiet either way.
      await this.#exec(["rm", "-f", name], { quiet: true });
    } catch {
      // Best effort during teardown.
    }
  }

  /** Spawn `docker` with the given args; see {@link execTool}. */
  #exec(args: string[], opts: ExecToolOptions = {}): Promise<number> {
    return execTool(this.#docker, args, opts);
  }
}
