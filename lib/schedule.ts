import type { Config, Step } from "./types.ts";

/** The combined set of prerequisites for a step (build_depends ∪ depends). */
export function prerequisites(step: Step): string[] {
  const seen = new Set<string>();
  for (const dep of step.build_depends) seen.add(dep);
  for (const dep of step.depends) seen.add(dep);
  return [...seen];
}

/**
 * Run every step exactly once, honouring its prerequisites, and processing
 * independent steps concurrently. Each step is handed to `process` only after
 * all of its prerequisites have finished successfully.
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
): Promise<string[]> {
  const remaining = new Map<string, Set<string>>();
  for (const [name, step] of config.steps) {
    remaining.set(name, new Set(prerequisites(step)));
  }

  const completed = new Set<string>();
  const started = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  let failure: unknown;

  const launchReady = (): void => {
    if (failure !== undefined) return;
    for (const [name, deps] of remaining) {
      if (started.has(name)) continue;
      if (deps.size > 0) continue;
      started.add(name);
      const step = config.steps.get(name)!;
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
