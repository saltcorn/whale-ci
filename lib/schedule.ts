import type { Config, Step } from "./types.ts";

/** The deduplicated set of prerequisites for a step. */
export function prerequisites(step: Step): string[] {
  return [...new Set(step.depends)];
}

/**
 * Run every step exactly once, honouring its prerequisites, and processing
 * independent steps concurrently. Each step is handed to `process` only after
 * all of its prerequisites have finished successfully.
 *
 * At most `maxConcurrency` non-service steps are in flight at once; service
 * steps do not count toward the limit (their `process` call only covers
 * startup, and the container keeps running outside the scheduler's view).
 *
 * If any step rejects, no new steps are started and the returned promise
 * rejects once the already-running steps have settled.
 *
 * Returns the names of every step that completed successfully, which the
 * caller uses to know which containers need stopping.
 */
export async function runScheduled(
  config: Config,
  process: (step: Step) => Promise<void>,
  signal?: AbortSignal,
  maxConcurrency = Infinity,
): Promise<string[]> {
  const remaining = new Map<string, Set<string>>();
  for (const [name, step] of config.steps) {
    remaining.set(name, new Set(prerequisites(step)));
  }

  const completed = new Set<string>();
  const started = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  // Non-service steps currently in flight, capped at maxConcurrency.
  let runningJobs = 0;
  let failure: unknown;

  const launchReady = (): void => {
    if (failure !== undefined) return;
    // Stop launching new steps once the run has been interrupted.
    if (signal?.aborted) return;
    for (const [name, deps] of remaining) {
      if (started.has(name)) continue;
      if (deps.size > 0) continue;
      const step = config.steps.get(name)!;
      if (!step.service && runningJobs >= maxConcurrency) continue;
      if (!step.service) runningJobs += 1;
      started.add(name);
      const task = process(step).then(
        () => {
          completed.add(name);
        },
        (err) => {
          if (failure === undefined) failure = err;
          throw err;
        },
      );
      inFlight.set(name, task);
    }
  };

  launchReady();

  while (inFlight.size > 0) {
    const settled = await Promise.race(
      [...inFlight].map(([name, task]) =>
        task.then(
          () => name,
          () => name,
        ),
      ),
    );
    inFlight.delete(settled);
    if (!config.steps.get(settled)!.service) runningJobs -= 1;

    if (failure === undefined && completed.has(settled)) {
      remaining.delete(settled);
      for (const deps of remaining.values()) {
        deps.delete(settled);
      }
      launchReady();
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  return [...completed];
}
