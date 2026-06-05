import {
  CliDockerClient,
  type DockerClient,
  imageTag,
  type LogFollower,
  type OutputSink,
  type RunOptions,
  splitCommand,
} from "./docker.ts";
import type { StepReport, StepStatus } from "./report.ts";
import { runScheduled } from "./schedule.ts";
import type { Config, Step } from "./types.ts";

export interface RunnerOptions {
  /** Docker client to use; defaults to the real `docker` CLI. */
  docker?: DockerClient;
  /** Network name; defaults to a unique per-run name. */
  network?: string;
  /** Sink for progress messages; defaults to console.error. */
  log?: (message: string) => void;
  /**
   * Capture each step's output (for the HTML report). When false (the default)
   * docker streams straight to the terminal and `StepReport.output` is empty.
   */
  captureOutput?: boolean;
  /** Sleep for a number of milliseconds; defaults to a real timer. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of a whole pipeline run. */
export interface PipelineResult {
  /** True if every step succeeded. */
  ok: boolean;
  /** Per-step results in config order, suitable for the HTML report. */
  steps: StepReport[];
}

/** Mutable bookkeeping for one step while the pipeline runs. */
interface StepRecord {
  name: string;
  service: boolean;
  status: StepStatus;
  startedAt: number;
  endedAt: number | undefined;
  output: string;
}

/**
 * Build every image and run the CI pipeline described by `config`.
 *
 * Steps are processed concurrently where their `depends` allow. A step marked
 * `service: true` is started detached and kept running only while at least one
 * other step still depends on it; it is stopped as soon as the last such
 * dependent finishes. A step that is not a service runs its `command` to
 * completion (or, with no command, only has its image built). A dependency is
 * considered ready when a service dependency is running, or when a non-service
 * dependency has completed.
 *
 * Resolves with `ok` (false if any build failed or a job exited non-zero) and a
 * per-step report. All started containers and the network are always cleaned up
 * before returning.
 */
export async function runPipeline(
  config: Config,
  options: RunnerOptions = {},
): Promise<PipelineResult> {
  const docker = options.docker ?? new CliDockerClient();
  const network = options.network ?? `dockerci-${process.pid}-${Date.now()}`;
  const log = options.log ?? ((message: string) => console.error(message));
  const capture = options.captureOutput ?? false;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const dependents = dependentsOf(config);
  // For each service, how many dependents have not finished yet.
  const required = new Map<string, number>();
  for (const [name, who] of dependents) {
    required.set(name, who.size);
  }

  const started = new Set<string>();
  const stopped = new Set<string>();
  // Live log followers for running services, so their output streams as it
  // happens rather than being dumped when the service is stopped.
  const followers = new Map<string, LogFollower>();
  let ok = true;

  // One record per step, created up front so the report keeps config order.
  const records = new Map<string, StepRecord>();
  for (const [name, step] of config.steps) {
    records.set(name, {
      name,
      service: step.service,
      status: "success",
      startedAt: 0,
      endedAt: undefined,
      output: "",
    });
  }

  const containerName = (name: string): string => `${network}-${name}`;

  /** Output sink that appends to a step's record, or undefined when not capturing. */
  const sinkFor = (name: string): OutputSink | undefined => {
    if (!capture) return undefined;
    const record = records.get(name)!;
    return (chunk) => {
      record.output += chunk;
    };
  };

  const optionsFor = (
    step: Step,
    command: string[] | undefined,
    overrides: { image?: string; name?: string; keep?: boolean } = {},
  ): RunOptions => ({
    image: overrides.image ?? imageTag(step),
    name: overrides.name ?? containerName(step.name),
    network,
    alias: step.name,
    command,
    environment: step.environment,
    ports: step.ports,
    keep: overrides.keep,
  });

  /**
   * Run a non-service step's commands. A single command runs in a throwaway
   * `--rm` container. Multiple commands each run through the image's entrypoint
   * in turn, and the container is committed to a temporary image between them so
   * filesystem state carries forward — this keeps any ENTRYPOINT intact (unlike
   * a shell `&&` join, which the entrypoint would swallow). Execution stops at
   * the first command that fails, which fails the whole step.
   */
  const runCommands = async (step: Step, commands: string[]): Promise<void> => {
    const sink = sinkFor(step.name);
    if (commands.length === 1) {
      log(`Running ${step.name}: ${commands[0]}`);
      const code = await docker.run(
        optionsFor(step, splitCommand(commands[0])),
        sink,
      );
      if (code !== 0) {
        throw new Error(`Step "${step.name}" failed with exit code ${code}`);
      }
      return;
    }

    let image = imageTag(step);
    const intermediates: string[] = [];
    try {
      for (let i = 0; i < commands.length; i++) {
        const container = `${containerName(step.name)}-cmd${i}`;
        const last = i === commands.length - 1;
        try {
          log(`Running ${step.name}: ${commands[i]}`);
          const code = await docker.run(
            optionsFor(step, splitCommand(commands[i]), {
              image,
              name: container,
              keep: true,
            }),
            sink,
          );
          if (code !== 0) {
            throw new Error(`Step "${step.name}" failed with exit code ${code}`);
          }
          if (!last) {
            // Snapshot the container's filesystem for the next command to build on.
            image = `${containerName(step.name)}-snapshot${i}`;
            await docker.commit(container, image);
            intermediates.push(image);
          }
        } finally {
          await docker.stop(container);
        }
      }
    } finally {
      for (const tag of intermediates) {
        await docker.removeImage(tag);
      }
    }
  };

  const buildOrPull = async (step: Step): Promise<void> => {
    const sink = sinkFor(step.name);
    if (step.dockerfile !== undefined) {
      log(`Building ${step.name} (${step.dockerfile})`);
      await docker.build(imageTag(step), step.dockerfile, config.baseDir, sink);
    } else if (step.imageFrom !== undefined) {
      // The image is produced by the build step we depend on; nothing to pull.
      log(`Using image from ${step.imageFrom} for ${step.name}`);
    } else {
      log(`Pulling ${step.name} (${step.image})`);
      await docker.pull(step.image!, sink);
    }
  };

  /** Stop a running service, draining its live log follower and recording when it ended. */
  const stopService = async (name: string): Promise<void> => {
    // Remove the container first so its log stream reaches EOF, then let the
    // follower drain the last of the output before we record the end time.
    await docker.stop(containerName(name));
    const follower = followers.get(name);
    if (follower !== undefined) {
      followers.delete(name);
      await follower.stop();
    }
    const record = records.get(name)!;
    record.endedAt = Date.now();
  };

  /**
   * Mark `step` as finished and release the services it depended on. When a
   * service's last dependent finishes it is stopped, which in turn releases the
   * services *it* depended on, cascading up the graph.
   */
  const finish = async (step: Step): Promise<void> => {
    for (const depName of new Set(step.depends)) {
      const dep = config.steps.get(depName)!;
      if (!dep.service) continue;
      const left = (required.get(depName) ?? 0) - 1;
      required.set(depName, left);
      if (left <= 0 && started.has(depName) && !stopped.has(depName)) {
        stopped.add(depName);
        log(`Stopping service ${depName} (no longer required)`);
        await stopService(depName);
        await finish(dep);
      }
    }
  };

  const processStep = async (step: Step): Promise<void> => {
    const record = records.get(step.name)!;
    record.startedAt = Date.now();
    try {
      if (
        step.service && (dependents.get(step.name)?.size ?? 0) === 0
      ) {
        log(`Skipping service ${step.name} (not required by any step)`);
        record.status = "skipped";
        record.endedAt = record.startedAt;
        return;
      }

      if (step.delay !== undefined) {
        // Wait the configured delay on top of waiting for dependencies.
        log(`Delaying ${step.name} for ${step.delay}s`);
        await sleep(step.delay * 1000);
      }

      if (step.service) {
        await buildOrPull(step);
        log(`Starting service ${step.name}`);
        started.add(step.name);
        // A service has at most one command (enforced at parse time).
        const argv = step.command ? splitCommand(step.command[0]) : undefined;
        await docker.startDetached(optionsFor(step, argv), sinkFor(step.name));
        // Follow the service's output live so it streams as it happens.
        const follower = docker.followLogs(
          containerName(step.name),
          sinkFor(step.name),
          step.readyOn,
        );
        followers.set(step.name, follower);
        if (step.readyOn !== undefined) {
          // Hold dependents until the service announces it is ready.
          log(`Waiting for ${step.name} to be ready (ready_on: ${step.readyOn})`);
          await follower.ready;
          log(`Service ${step.name} is ready`);
        }
        // A service keeps running; it is stopped (and its end recorded) by
        // finish() / teardown once no longer needed.
        return;
      }

      await buildOrPull(step);
      if (step.command !== undefined) {
        await runCommands(step, step.command);
      }
      record.endedAt = Date.now();
      await finish(step);
    } catch (err) {
      record.status = "failure";
      if (record.endedAt === undefined) record.endedAt = Date.now();
      throw err;
    }
  };

  await docker.createNetwork(network);
  try {
    await runScheduled(config, processStep);
  } catch (err) {
    ok = false;
    log(`Pipeline failed: ${(err as Error).message}`);
  } finally {
    for (const name of started) {
      if (!stopped.has(name)) {
        await stopService(name);
      }
    }
    await docker.removeNetwork(network);
  }

  return { ok, steps: toReports(config, records) };
}

/** Freeze the live records into ordered, immutable StepReports. */
function toReports(
  config: Config,
  records: Map<string, StepRecord>,
): StepReport[] {
  const reports: StepReport[] = [];
  for (const name of config.steps.keys()) {
    const record = records.get(name)!;
    const end = record.endedAt ?? record.startedAt;
    reports.push({
      name: record.name,
      service: record.service,
      status: record.status,
      durationMs: Math.max(0, end - record.startedAt),
      output: record.output,
    });
  }
  return reports;
}

/** Map each step name to the set of steps that depend on it. */
export function dependentsOf(config: Config): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const name of config.steps.keys()) {
    map.set(name, new Set());
  }
  for (const step of config.steps.values()) {
    for (const dep of step.depends) {
      map.get(dep)!.add(step.name);
    }
  }
  return map;
}
