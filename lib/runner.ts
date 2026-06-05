import {
  CliDockerClient,
  type DockerClient,
  imageTag,
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

  const dependents = dependentsOf(config);
  // For each service, how many dependents have not finished yet.
  const required = new Map<string, number>();
  for (const [name, who] of dependents) {
    required.set(name, who.size);
  }

  const started = new Set<string>();
  const stopped = new Set<string>();
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

  const optionsFor = (step: Step): RunOptions => ({
    image: imageTag(step),
    name: containerName(step.name),
    network,
    alias: step.name,
    command: splitCommand(step.command),
    environment: step.environment,
    volumes: step.volumes,
    ports: step.ports,
  });

  const buildOrPull = async (step: Step): Promise<void> => {
    const sink = sinkFor(step.name);
    if (step.dockerfile !== undefined) {
      log(`Building ${step.name} (${step.dockerfile})`);
      await docker.build(imageTag(step), step.dockerfile, config.baseDir, sink);
    } else {
      log(`Pulling ${step.name} (${step.image})`);
      await docker.pull(step.image!, sink);
    }
  };

  /** Stop a running service, capturing its logs and recording when it ended. */
  const stopService = async (name: string): Promise<void> => {
    if (capture) {
      await docker.logs(containerName(name), sinkFor(name));
    }
    await docker.stop(containerName(name));
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
      if (step.service) {
        if ((dependents.get(step.name)?.size ?? 0) === 0) {
          log(`Skipping service ${step.name} (not required by any step)`);
          record.status = "skipped";
          record.endedAt = record.startedAt;
          return;
        }
        await buildOrPull(step);
        log(`Starting service ${step.name}`);
        started.add(step.name);
        await docker.startDetached(optionsFor(step), sinkFor(step.name));
        // A service keeps running; it is stopped (and its end recorded) by
        // finish() / teardown once no longer needed.
        return;
      }

      await buildOrPull(step);
      if (step.command !== undefined) {
        // Jobs run with `--rm`, so they clean themselves up; only services are
        // tracked for explicit teardown.
        log(`Running ${step.name}: ${step.command}`);
        const code = await docker.run(optionsFor(step), sinkFor(step.name));
        if (code !== 0) {
          throw new Error(`Step "${step.name}" failed with exit code ${code}`);
        }
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
