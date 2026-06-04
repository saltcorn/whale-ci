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
  volumes: string[];
  ports: number[];
}

/**
 * The docker operations the runner needs. Abstracted behind an interface so
 * the orchestration can be tested without a real docker daemon.
 */
export interface DockerClient {
  createNetwork(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  /** Build an image from a Dockerfile. */
  build(tag: string, dockerfile: string, context: string): Promise<void>;
  /** Pull an image from a registry. */
  pull(image: string): Promise<void>;
  /** Run a container to completion, resolving with its exit code. */
  run(options: RunOptions): Promise<number>;
  /** Start a container detached, resolving once it is running. */
  startDetached(options: RunOptions): Promise<void>;
  /** Stop and remove a container by name; never rejects. */
  stop(name: string): Promise<void>;
}

/** The image tag used for a step. Built steps get a `dockerci/` prefix. */
export function imageTag(step: Step): string {
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
  const args = ["run", "--rm", detached ? "-d" : "-i"];
  args.push("--name", options.name);
  args.push("--network", options.network);
  args.push("--network-alias", options.alias);
  for (const volume of options.volumes) {
    args.push("-v", volume);
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

  async build(tag: string, dockerfile: string, context: string): Promise<void> {
    await this.#exec(buildArgs(tag, resolve(context, dockerfile), resolve(context)));
  }

  async pull(image: string): Promise<void> {
    await this.#exec(["pull", image]);
  }

  async run(options: RunOptions): Promise<number> {
    return await this.#exec(runArgs(options, false), { allowNonZero: true });
  }

  async startDetached(options: RunOptions): Promise<void> {
    await this.#exec(runArgs(options, true));
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
   * Spawn `docker` with the given args, inheriting stdio so build/test output
   * streams to the user. Resolves with the exit code; rejects on non-zero
   * unless `allowNonZero` is set.
   */
  #exec(
    args: string[],
    opts: { allowNonZero?: boolean; quiet?: boolean } = {},
  ): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const stdio = opts.quiet ? "ignore" : "inherit";
      const child = spawn(this.#docker, args, { stdio });
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
