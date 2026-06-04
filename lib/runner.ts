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
 * Steps are processed concurrently where their dependencies allow. A step is
 * treated as a long-running *service* (started detached) when another step
 * depends on it; otherwise a step with a `command` is run to completion as a
 * *job*. A step with neither role only has its image built (e.g. a base build
 * image consumed via `build_depends`).
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

  const services = serviceSteps(config);
  const started: string[] = [];
  let ok = true;

  const containerName = (step: Step): string => `${network}-${step.name}`;

  const optionsFor = (step: Step): RunOptions => ({
    image: imageTag(step),
    name: containerName(step),
    network,
    alias: step.name,
    command: splitCommand(step.command),
    volumes: step.volumes,
    ports: step.ports,
  });

  const processStep = async (step: Step): Promise<void> => {
    if (step.dockerfile !== undefined) {
      log(`Building ${step.name} (${step.dockerfile})`);
      await docker.build(imageTag(step), step.dockerfile, config.baseDir);
    } else {
      log(`Pulling ${step.name} (${step.image})`);
      await docker.pull(step.image!);
    }

    if (services.has(step.name)) {
      log(`Starting service ${step.name}`);
      started.push(containerName(step));
      await docker.startDetached(optionsFor(step));
    } else if (step.command !== undefined) {
      log(`Running ${step.name}: ${step.command}`);
      started.push(containerName(step));
      const code = await docker.run(optionsFor(step));
      if (code !== 0) {
        throw new Error(`Step "${step.name}" failed with exit code ${code}`);
      }
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
      await docker.stop(name);
    }
    await docker.removeNetwork(network);
  }

  return ok;
}

/** Names of steps that another step depends on, i.e. long-running services. */
export function serviceSteps(config: Config): Set<string> {
  const services = new Set<string>();
  for (const step of config.steps.values()) {
    for (const dep of step.depends) {
      services.add(dep);
    }
  }
  return services;
}
