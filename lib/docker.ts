import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Step } from "./types.ts";

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

/**
 * Receives chunks of combined stdout/stderr from a docker command, so a step's
 * output can be captured for the HTML report. When no sink is given the command
 * streams straight to the terminal instead.
 */
export type OutputSink = (chunk: string) => void;

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
 * the output is both streamed to the terminal and forwarded to the sink.
 */
export interface DockerClient {
  createNetwork(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /** Build an image from a Dockerfile. */
  build(
    tag: string,
    dockerfile: string,
    context: string,
    sink?: OutputSink,
  ): Promise<void>;
  /** Pull an image from a registry. */
  pull(image: string, sink?: OutputSink): Promise<void>;
  /** Run a container to completion, resolving with its exit code. */
  run(options: RunOptions, sink?: OutputSink): Promise<number>;
  /** Start a container detached, resolving once it is running. */
  startDetached(options: RunOptions, sink?: OutputSink): Promise<void>;
  /**
   * Start following a container's output live, streaming each chunk to the
   * terminal and (if given) the sink as it arrives — so a service's output is
   * not deferred until the step ends. When `readyNeedle` is supplied the
   * returned handle's `ready` promise resolves when that string appears.
   */
  followLogs(
    name: string,
    sink?: OutputSink,
    readyNeedle?: string,
  ): LogFollower;
  /** Commit a stopped container's filesystem to a new image tag. */
  commit(container: string, tag: string): Promise<void>;
  /** Remove an image by tag; never rejects. */
  removeImage(tag: string): Promise<void>;
  /** Stop and remove a container by name; never rejects. */
  stop(name: string): Promise<void>;
}

/** The image tag used for a step. Built steps get a `dockerci/` prefix. */
export function imageTag(step: Step): string {
  // An `image` that names another build step runs that step's generated image.
  if (step.imageFrom !== undefined) {
    return `dockerci/${step.imageFrom}:latest`;
  }
  if (step.image !== undefined) {
    return step.image;
  }
  return `dockerci/${step.name}:latest`;
}

/** Split a `command:` string into argv. Empty / missing -> undefined. */
export function splitCommand(command: string | undefined): string[] | undefined {
  if (command === undefined) return undefined;
  const parts = command.trim().split(/\s+/).filter((p) => p.length > 0);
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
  ): Promise<void> {
    await this.#exec(
      buildArgs(tag, resolve(context, dockerfile), resolve(context)),
      { sink },
    );
  }

  async pull(image: string, sink?: OutputSink): Promise<void> {
    await this.#exec(["pull", image], { sink });
  }

  async run(options: RunOptions, sink?: OutputSink): Promise<number> {
    return await this.#exec(runArgs(options, false), {
      allowNonZero: true,
      sink,
    });
  }

  async startDetached(options: RunOptions, sink?: OutputSink): Promise<void> {
    await this.#exec(runArgs(options, true), { sink });
  }

  /**
   * Follow `docker logs -f` (which replays existing output before following, so
   * nothing printed before we attach is missed) and stream every chunk straight
   * to the terminal and the sink as it arrives. When `readyNeedle` is set,
   * `ready` resolves the moment it appears; if the container stops first the
   * stream ends and `ready` rejects, so a service that dies before signalling
   * readiness fails the step.
   */
  followLogs(
    name: string,
    sink?: OutputSink,
    readyNeedle?: string,
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
      out.write(text);
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

  /**
   * Spawn `docker` with the given args. With a `sink` the output is piped and
   * teed to both the terminal and the sink (for the report); otherwise stdio is
   * inherited so docker can stream directly. Resolves with the exit code;
   * rejects on non-zero unless `allowNonZero` is set.
   */
  #exec(
    args: string[],
    opts: { allowNonZero?: boolean; quiet?: boolean; sink?: OutputSink } = {},
  ): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const stdio = opts.sink ? "pipe" : opts.quiet ? "ignore" : "inherit";
      const child = spawn(this.#docker, args, { stdio });

      if (opts.sink) {
        const tee = (
          stream: NodeJS.ReadableStream | null,
          out: NodeJS.WriteStream,
        ): void => {
          stream?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            out.write(text);
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
          reject(new Error(`docker ${args.join(" ")} exited with ${exitCode}`));
        } else {
          resolvePromise(exitCode);
        }
      });
    });
  }
}
