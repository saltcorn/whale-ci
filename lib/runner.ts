import {
  cacheImageTag,
  CliDockerClient,
  commandArgv,
  type DockerClient,
  imageTag,
  type LogFollower,
  type OutputSink,
  type RunOptions,
} from "./docker.ts";
import { CliIncusClient, type IncusClient, instanceName } from "./incus.ts";
import { runShell, type ShellResult } from "./proc.ts";
import type { StepReport, StepStatus } from "./report.ts";
import { runScheduled } from "./schedule.ts";
import type { Config, Step } from "./types.ts";

export interface RunnerOptions {
  /** Docker client to use; defaults to the real `docker` CLI. */
  docker?: DockerClient;
  /** Incus client for `runtime: incus` steps; defaults to the real `incus` CLI. */
  incus?: IncusClient;
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
  /**
   * Run a shell command on the host, resolving with its exit code and captured
   * stdout; used for `only-if` conditions (step and push) and for `$(...)`
   * push tags. Defaults to `bash -c` with stderr discarded. Injectable for
   * tests.
   */
  shell?: (command: string) => Promise<ShellResult>;
  /**
   * Schedule `fire` to run after `ms` milliseconds, returning a canceller that
   * prevents it from firing. Used to enforce per-step timeouts; defaults to
   * setTimeout/clearTimeout. Injectable for tests.
   */
  timer?: (ms: number, fire: () => void) => () => void;
  /**
   * Abort signal for interrupting the run (e.g. on Ctrl-C). When it aborts, no
   * new steps are started and every running container is stopped and the network
   * removed before the run returns (with `ok: false`).
   */
  signal?: AbortSignal;
  /**
   * Maximum number of test (non-service) containers running in parallel.
   * Service containers do not count toward the limit. Defaults to 4.
   */
  maxConcurrency?: number;
  /**
   * Invoked with an ordered snapshot of every step's report the moment a step
   * settles (success, failure or skipped), and once before any step starts with
   * all steps `pending`. Lets a caller render an incremental report that updates
   * as the run progresses. The snapshot is a fresh copy each call.
   */
  onProgress?: (steps: StepReport[]) => void;
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
 * Steps are processed concurrently where their `depends` allow, with at most
 * `maxConcurrency` non-service steps in flight at once. A step marked
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
  const incus = options.incus ?? new CliIncusClient();
  const network = options.network ?? `dockerci-${process.pid}-${Date.now()}`;
  // The network name is unique per run, so it doubles as the run id that scopes
  // this run's built image tags away from any concurrent run's.
  const runId = network;
  const log = options.log ?? ((message: string) => console.error(message));
  const capture = options.captureOutput ?? false;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shell = options.shell ?? runShell;
  const timer = options.timer ??
    ((ms: number, fire: () => void) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    });

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
  // Names of job containers currently running, so an interrupted run can force
  // them down (services are tracked via `started`/`stopped`).
  const liveContainers = new Set<string>();
  // Incus instances currently running, force-deleted on an interrupted run.
  const liveInstances = new Set<string>();
  // Dockerfile-built images this run produced, mapping each per-run image tag to
  // the stable cache tag it is moved to at teardown. The image itself is kept
  // (under the cache tag) so its layers seed the next run's build cache; only the
  // per-run tag is dropped, so these images do not accumulate on the host.
  // Images built from a step's `command` are throwaway snapshots, purged where
  // they are created (see `runCommands`), not here.
  const builtImages = new Map<string, string>();
  let ok = true;

  // One record per step, created up front so the report keeps config order.
  // Steps start `pending` and are moved to a terminal state as they settle, so
  // an incremental report rendered mid-run shows what is done and what is not.
  const records = new Map<string, StepRecord>();
  for (const [name, step] of config.steps) {
    records.set(name, {
      name,
      service: step.service,
      status: "pending",
      startedAt: 0,
      endedAt: undefined,
      output: "",
    });
  }

  // Notify the caller with a fresh snapshot whenever a step settles (and once up
  // front, all pending), so a server can rewrite its report as the run proceeds.
  const onProgress = options.onProgress;
  const emitProgress = onProgress === undefined
    ? (): void => {}
    : (): void => onProgress(toReports(config, records));

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
    image: overrides.image ?? imageTag(step, runId),
    name: overrides.name ?? containerName(step.name),
    network,
    alias: step.name,
    command,
    environment: step.environment,
    ports: step.ports,
    extraHosts: step.extraHosts,
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
      const container = containerName(step.name);
      liveContainers.add(container);
      try {
        log(`Running ${step.name}: ${commands[0]}`);
        const code = await docker.run(
          optionsFor(step, commandArgv(commands[0])),
          sink,
          step.quiet,
        );
        if (code !== 0) {
          throw new Error(`Step "${step.name}" failed with exit code ${code}`);
        }
      } finally {
        liveContainers.delete(container);
      }
      return;
    }

    let image = imageTag(step, runId);
    const intermediates: string[] = [];
    try {
      for (let i = 0; i < commands.length; i++) {
        const container = `${containerName(step.name)}-cmd${i}`;
        const last = i === commands.length - 1;
        liveContainers.add(container);
        try {
          log(`Running ${step.name}: ${commands[i]}`);
          const code = await docker.run(
            optionsFor(step, commandArgv(commands[i]), {
              image,
              name: container,
              keep: true,
            }),
            sink,
            step.quiet,
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
          liveContainers.delete(container);
        }
      }
    } finally {
      for (const tag of intermediates) {
        await docker.removeImage(tag);
      }
    }
  };

  /**
   * Run a `runtime: incus` step. An ephemeral incus instance is launched from
   * the step's image (pulling it on first use), each command runs inside it via
   * `incus exec` — the instance keeps running between commands, so filesystem
   * state carries forward without any commit/snapshot dance — and the instance
   * is always deleted afterwards. Incus instances never join the run's docker
   * network: there is no shared network between incus and docker steps.
   */
  const runIncusStep = async (step: Step): Promise<void> => {
    const sink = sinkFor(step.name);
    const name = instanceName(containerName(step.name));
    liveInstances.add(name);
    try {
      log(`Launching ${step.name} (${step.image}) with incus`);
      await incus.launch(
        { image: step.image!, name, ports: step.ports },
        sink,
        step.quiet,
      );
      for (const command of step.command ?? []) {
        log(`Running ${step.name}: ${command}`);
        const argv = commandArgv(command);
        if (argv === undefined) continue;
        const code = await incus.exec(
          name,
          argv,
          step.environment,
          sink,
          step.quiet,
        );
        if (code !== 0) {
          throw new Error(`Step "${step.name}" failed with exit code ${code}`);
        }
      }
    } finally {
      await incus.delete(name);
      liveInstances.delete(name);
    }
  };

  const buildOrPull = async (step: Step): Promise<void> => {
    const sink = sinkFor(step.name);
    if (step.dockerfile !== undefined) {
      // When the step's Dockerfile builds FROM another step, use that step's
      // generated image as the base instead of pulling it from a registry.
      const baseImage = step.baseFrom !== undefined
        ? imageTag(config.steps.get(step.baseFrom)!, runId)
        : undefined;
      log(
        baseImage !== undefined
          ? `Building ${step.name} (${step.dockerfile}) on ${step.baseFrom}`
          : `Building ${step.name} (${step.dockerfile})`,
      );
      const tag = imageTag(step, runId);
      builtImages.set(tag, cacheImageTag(step));
      await docker.build(
        tag,
        step.dockerfile,
        config.baseDir,
        sink,
        step.quiet,
        baseImage,
      );
    } else if (step.imageFrom !== undefined) {
      // The image is produced by the build step we depend on; nothing to pull.
      log(`Using image from ${step.imageFrom} for ${step.name}`);
    } else {
      log(`Pulling ${step.name} (${step.image})`);
      await docker.pull(step.image!, sink, step.quiet);
    }
  };

  /**
   * Resolve one configured push tag: a `$(command)` value is evaluated on the
   * host and its trimmed stdout becomes the tag; anything else is used as-is.
   * A command that fails or prints nothing throws, failing the step.
   */
  const resolvePushTag = async (step: Step, raw: string): Promise<string> => {
    const command = /^\$\((.*)\)$/s.exec(raw)?.[1];
    if (command === undefined) return raw;
    const result = await shell(command);
    if (result.code !== 0) {
      throw new Error(
        `Step "${step.name}" push tag command failed with exit code ${result.code}: ${command}`,
      );
    }
    const tag = result.stdout.trim();
    if (tag === "") {
      throw new Error(
        `Step "${step.name}" push tag command produced no output: ${command}`,
      );
    }
    return tag;
  };

  /**
   * Push a step's built image to docker hub, as configured by its `push:`
   * section — once per configured tag, in order. The push `only-if` check
   * failing skips the push without failing the step; a `$(...)` tag command
   * failing (or yielding nothing) fails the step, since the image cannot be
   * pushed as intended.
   */
  const pushBuiltImage = async (step: Step): Promise<void> => {
    const push = step.push;
    if (push === undefined) return;
    if (push.onlyIf !== undefined && (await shell(push.onlyIf)).code !== 0) {
      log(`Not pushing ${step.name} (push only-if check failed: ${push.onlyIf})`);
      return;
    }
    for (const raw of push.tag ?? ["latest"]) {
      const target = `${push.image}:${await resolvePushTag(step, raw)}`;
      log(`Pushing ${step.name} as ${target}`);
      await docker.tagImage(imageTag(step, runId), target);
      await docker.push(target, sinkFor(step.name), step.quiet);
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

  /**
   * Run `work` under the step's `timeout-minutes` budget, if any. If the budget
   * elapses first the returned promise rejects (failing the step); the abandoned
   * work's container is force-stopped later during teardown. Steps without a
   * configured timeout run `work` unchanged.
   */
  const withTimeout = async (
    step: Step,
    work: () => Promise<void>,
  ): Promise<void> => {
    if (step.timeoutMinutes === undefined) {
      await work();
      return;
    }
    let cancel = (): void => {};
    const timeout = new Promise<never>((_, reject) => {
      cancel = timer(step.timeoutMinutes! * 60_000, () => {
        reject(
          new Error(
            `Step "${step.name}" timed out after ${step.timeoutMinutes} minute(s)`,
          ),
        );
      });
    });
    try {
      await Promise.race([work(), timeout]);
    } finally {
      cancel();
    }
  };

  const processStep = async (step: Step): Promise<void> => {
    const record = records.get(step.name)!;
    record.startedAt = Date.now();
    try {
      if (step.onlyIf !== undefined && (await shell(step.onlyIf)).code !== 0) {
        log(`Skipping ${step.name} (only-if check failed: ${step.onlyIf})`);
        record.status = "skipped";
        record.endedAt = Date.now();
        // The skipped step still counts as completed: its dependents run, and
        // the services it depended on are released.
        await finish(step);
        return;
      }

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
        await withTimeout(step, async () => {
          await buildOrPull(step);
          log(`Starting service ${step.name}`);
          started.add(step.name);
          // A service has at most one command (enforced at parse time).
          const argv = step.command ? commandArgv(step.command[0]) : undefined;
          await docker.startDetached(
            optionsFor(step, argv),
            sinkFor(step.name),
            step.quiet,
          );
          // Follow the service's output live so it streams as it happens.
          const follower = docker.followLogs(
            containerName(step.name),
            sinkFor(step.name),
            step.readyOn,
            step.quiet,
          );
          followers.set(step.name, follower);
          if (step.readyOn !== undefined) {
            // Hold dependents until the service announces it is ready.
            log(
              `Waiting for ${step.name} to be ready (ready-on: ${step.readyOn})`,
            );
            await follower.ready;
            log(`Service ${step.name} is ready`);
          }
        });
        await pushBuiltImage(step);
        // A started service counts as passed for the report; it keeps running
        // and is stopped (and its end recorded) by finish() / teardown once no
        // longer needed.
        record.status = "success";
        return;
      }

      await withTimeout(step, async () => {
        // An incus step cannot be a service (enforced at parse time), so the
        // runtime split only exists on this job path.
        if (step.runtime === "incus") {
          await runIncusStep(step);
          return;
        }
        await buildOrPull(step);
        if (step.command !== undefined) {
          await runCommands(step, step.command);
        }
      });
      // The push happens outside the timeout budget: that covers the step's
      // execution, not the upload of its image.
      await pushBuiltImage(step);
      record.status = "success";
      record.endedAt = Date.now();
      await finish(step);
    } catch (err) {
      record.status = "failure";
      if (record.endedAt === undefined) record.endedAt = Date.now();
      throw err;
    } finally {
      // The step has reached a terminal state (or is a started service): let the
      // caller re-render its report to reflect this step's outcome.
      emitProgress();
    }
  };

  // Stop every running container and remove the network. Memoised so the abort
  // handler and the normal finally share one run, and the finally awaits it even
  // when the handler started it first.
  let teardownStarted: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    teardownStarted ??= (async () => {
      for (const name of started) {
        if (!stopped.has(name)) {
          await stopService(name);
        }
      }
      // Force down any job container still running (e.g. an interrupted step).
      for (const name of [...liveContainers]) {
        liveContainers.delete(name);
        await docker.stop(name);
      }
      // Likewise any incus instance an interrupted or timed-out step left behind.
      for (const name of [...liveInstances]) {
        liveInstances.delete(name);
        await incus.delete(name);
      }
      // Keep this run's Dockerfile-built images so they seed the next run's
      // build cache: move each to its stable cache tag, then drop the per-run
      // tag so the image survives (under the cache tag) without piling up.
      for (const [runTag, cacheTag] of builtImages) {
        await docker.tagImage(runTag, cacheTag);
        await docker.removeImage(runTag);
      }
      await docker.removeNetwork(network);
    })();
    return teardownStarted;
  };

  const signal = options.signal;
  const onAbort = (): void => {
    log("Interrupted; stopping containers...");
    void teardown();
  };
  // On an already-aborted signal this never fires; launchReady's abort check
  // then skips every step and the finally still tears the network down.
  signal?.addEventListener("abort", onAbort, { once: true });

  // Emit the initial, all-pending report before any work starts, so a server
  // can publish it the moment the run begins.
  emitProgress();

  await docker.createNetwork(network);
  try {
    await runScheduled(config, processStep, signal, options.maxConcurrency ?? 4);
  } catch (err) {
    ok = false;
    log(`Pipeline failed: ${(err as Error).message}`);
  } finally {
    await teardown();
    signal?.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted) ok = false;

  // Any step left pending never ran — an earlier failure or an interrupt stopped
  // the schedule before it was reached. Record it as skipped so the final report
  // shows a settled outcome rather than a step stuck pending forever.
  for (const record of records.values()) {
    if (record.status === "pending") record.status = "skipped";
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
