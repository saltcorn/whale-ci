import {
  CliDockerClient,
  type DockerClient,
  imageTag,
  type RunOptions,
  splitCommand,
} from "./docker.ts";
import { runScheduled } from "./schedule.ts";
import type { Config, Step } from "./types.ts";

export interface RunnerOptions {
  /** Docker client to use; defaults to the real `docker` CLI. */
  docker?: DockerClient;
  /** Network name; defaults to a unique per-run name. */
  network?: string;
  /** Sink for progress messages; defaults to console.error. */
  log?: (message: string) => void;
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
 * Resolves `true` if the pipeline succeeded, `false` if any build failed or a
 * job exited non-zero. All started containers and the network are always
 * cleaned up before returning.
 */
export async function runPipeline(
  config: Config,
  options: RunnerOptions = {},
): Promise<boolean> {
  const docker = options.docker ?? new CliDockerClient();
  const network = options.network ?? `dockerci-${process.pid}-${Date.now()}`;
  const log = options.log ?? ((message: string) => console.error(message));

  const dependents = dependentsOf(config);
  // For each service, how many dependents have not finished yet.
  const required = new Map<string, number>();
  for (const [name, who] of dependents) {
    required.set(name, who.size);
  }

  const started = new Set<string>();
  const stopped = new Set<string>();
  let ok = true;

  const containerName = (name: string): string => `${network}-${name}`;

  const optionsFor = (step: Step): RunOptions => ({
    image: imageTag(step),
    name: containerName(step.name),
    network,
    alias: step.name,
    command: splitCommand(step.command),
    volumes: step.volumes,
    ports: step.ports,
  });

  const buildOrPull = async (step: Step): Promise<void> => {
    if (step.dockerfile !== undefined) {
      log(`Building ${step.name} (${step.dockerfile})`);
      await docker.build(imageTag(step), step.dockerfile, config.baseDir);
    } else {
      log(`Pulling ${step.name} (${step.image})`);
      await docker.pull(step.image!);
    }
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
        await docker.stop(containerName(depName));
        await finish(dep);
      }
    }
  };

  const processStep = async (step: Step): Promise<void> => {
    if (step.service) {
      if ((dependents.get(step.name)?.size ?? 0) === 0) {
        log(`Skipping service ${step.name} (not required by any step)`);
        return;
      }
      await buildOrPull(step);
      log(`Starting service ${step.name}`);
      started.add(step.name);
      await docker.startDetached(optionsFor(step));
      // A service keeps running; it is stopped by finish() once no longer needed.
      return;
    }

    await buildOrPull(step);
    if (step.command !== undefined) {
      // Jobs run with `--rm`, so they clean themselves up; only services are
      // tracked for explicit teardown.
      log(`Running ${step.name}: ${step.command}`);
      const code = await docker.run(optionsFor(step));
      if (code !== 0) {
        throw new Error(`Step "${step.name}" failed with exit code ${code}`);
      }
    }
    await finish(step);
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
        await docker.stop(containerName(name));
      }
    }
    await docker.removeNetwork(network);
  }

  return ok;
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
