import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Config, ConfigError, type Step } from "./types.ts";

/** Keys that are accepted inside a step section. Anything else is an error. */
const KNOWN_KEYS = new Set([
  "dockerfile",
  "image",
  "service",
  "depends",
  "command",
  "environment",
  "ports",
  "disable",
  "ready-on",
  "delay",
  "timeout-minutes",
  "quiet",
]);

/** Read, parse and validate a config file, returning the structured Config. */
export async function loadConfig(file: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`Cannot read config file: ${file}`);
  }
  return parseConfig(text, dirname(resolve(file)));
}

/**
 * Parse and validate YAML config text. `baseDir` is the directory the file
 * lives in and is used to resolve Dockerfile build contexts.
 */
export function parseConfig(text: string, baseDir: string): Config {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${(err as Error).message}`);
  }

  if (doc === null || doc === undefined) {
    throw new ConfigError("Config file is empty");
  }
  if (!isPlainObject(doc)) {
    throw new ConfigError("Config file must be a mapping of step names");
  }

  const steps = new Map<string, Step>();
  for (const [name, raw] of Object.entries(doc)) {
    // A disabled step is completely ignored: parseStep returns undefined and it
    // never enters the pipeline (so it is not built, run, reported, or eligible
    // as a dependency target).
    const step = parseStep(name, raw);
    if (step !== undefined) {
      steps.set(name, step);
    }
  }

  if (steps.size === 0) {
    throw new ConfigError("Config file must define at least one step");
  }

  validateReferences(steps);
  resolveImageReferences(steps);
  detectCycles(steps);

  return { steps, baseDir };
}

/**
 * Validate and normalise a single step section. Returns `undefined` when the
 * step sets `disable: true`, signalling that it should be completely ignored.
 */
function parseStep(name: string, raw: unknown): Step | undefined {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`Step "${name}" must be a mapping`);
  }

  // Checked first so a disabled step is dropped without further validation.
  if (optionalBoolean(raw["disable"], name, "disable") === true) {
    return undefined;
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(`Step "${name}" has unknown key "${key}"`);
    }
  }

  const dockerfile = optionalString(raw["dockerfile"], name, "dockerfile");
  const image = optionalString(raw["image"], name, "image");
  if (dockerfile !== undefined && image !== undefined) {
    throw new ConfigError(
      `Step "${name}" cannot set both "dockerfile" and "image"`,
    );
  }
  if (dockerfile === undefined && image === undefined) {
    throw new ConfigError(
      `Step "${name}" must set either "dockerfile" or "image"`,
    );
  }

  const service = optionalBoolean(raw["service"], name, "service") ?? false;
  const command = commandList(raw["command"], name);
  if (service && command !== undefined && command.length > 1) {
    throw new ConfigError(
      `Step "${name}" is a service and cannot run multiple commands`,
    );
  }

  const readyOn = optionalString(raw["ready-on"], name, "ready-on");
  if (readyOn !== undefined && !service) {
    throw new ConfigError(
      `Step "${name}" sets "ready-on" but is not a service; ready-on only applies to services`,
    );
  }

  return {
    name,
    dockerfile,
    image,
    service,
    depends: stringList(raw["depends"], name, "depends"),
    command,
    environment: envList(raw["environment"], name),
    ports: portList(raw["ports"], name),
    readyOn,
    delay: optionalDelay(raw["delay"], name),
    timeoutMinutes: optionalTimeoutMinutes(raw["timeout-minutes"], name),
    quiet: optionalBoolean(raw["quiet"], name, "quiet") ?? false,
  };
}

/** Ensure every depends target names a real step. */
function validateReferences(steps: Map<string, Step>): void {
  for (const step of steps.values()) {
    for (const dep of step.depends) {
      if (dep === step.name) {
        throw new ConfigError(`Step "${step.name}" cannot depend on itself`);
      }
      if (!steps.has(dep)) {
        throw new ConfigError(
          `Step "${step.name}" depends on unknown step "${dep}"`,
        );
      }
    }
  }
}

/**
 * When a step's `image` names another step that builds its own image (i.e. has
 * a `dockerfile`), wire the two together: the step runs that build step's
 * generated image rather than pulling from a registry, and gains an implicit
 * dependency on it so the image exists before the step runs. An `image` that
 * does not name a build step is left untouched and pulled as before.
 */
function resolveImageReferences(steps: Map<string, Step>): void {
  for (const step of steps.values()) {
    if (step.image === undefined) continue;
    const target = steps.get(step.image);
    if (target === undefined || target.dockerfile === undefined) continue;
    step.imageFrom = step.image;
    if (!step.depends.includes(step.image)) {
      step.depends = [...step.depends, step.image];
    }
  }
}

/**
 * Detect dependency cycles across the depends graph using an iterative
 * depth-first search.
 */
function detectCycles(steps: Map<string, Step>): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (start: string): void => {
    const stack: Array<{ node: string; path: string[] }> = [
      { node: start, path: [start] },
    ];
    while (stack.length > 0) {
      const { node, path } = stack[stack.length - 1]!;
      if (state.get(node) === DONE) {
        stack.pop();
        continue;
      }
      if (state.get(node) !== VISITING) {
        state.set(node, VISITING);
      }
      const step = steps.get(node)!;
      let pushed = false;
      for (const dep of step.depends) {
        const depState = state.get(dep);
        if (depState === VISITING) {
          const cycle = [...path, dep].join(" -> ");
          throw new ConfigError(`Dependency cycle detected: ${cycle}`);
        }
        if (depState !== DONE) {
          stack.push({ node: dep, path: [...path, dep] });
          pushed = true;
          break;
        }
      }
      if (!pushed) {
        state.set(node, DONE);
        stack.pop();
      }
    }
  };

  for (const name of steps.keys()) {
    if (state.get(name) !== DONE) {
      visit(name);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function optionalString(
  value: unknown,
  step: string,
  key: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`Step "${step}" key "${key}" must be a string`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  step: string,
  key: string,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`Step "${step}" key "${key}" must be true or false`);
  }
  return value;
}

/** Accept a scalar string or a list of strings, always returning a list. */
function stringList(value: unknown, step: string, key: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `Step "${step}" key "${key}" must be a string or list of strings`,
    );
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ConfigError(
        `Step "${step}" key "${key}" must contain only strings`,
      );
    }
    return item;
  });
}

/**
 * Accept a `command` as either a single string or a list of strings, always
 * returning a list of command lines. An empty list (or no value) yields
 * `undefined`, meaning the step has no command.
 */
function commandList(value: unknown, step: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `Step "${step}" key "command" must be a string or list of strings`,
    );
  }
  const commands = value.map((item) => {
    if (typeof item !== "string") {
      throw new ConfigError(
        `Step "${step}" key "command" must contain only strings`,
      );
    }
    return item;
  });
  return commands.length > 0 ? commands : undefined;
}

/**
 * Accept environment variables either as a mapping (`KEY: value`) or a list of
 * `KEY=value` strings, always returning a list of `KEY=value` strings.
 */
function envList(value: unknown, step: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") {
        throw new ConfigError(
          `Step "${step}" key "environment" list must contain "KEY=value" strings`,
        );
      }
      return item;
    });
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(
      ([key, val]) => `${key}=${envValue(val, step, key)}`,
    );
  }
  throw new ConfigError(
    `Step "${step}" key "environment" must be a mapping or a list`,
  );
}

/** Coerce a single environment value (string, number or boolean) to a string. */
function envValue(value: unknown, step: string, key: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new ConfigError(
    `Step "${step}" environment value for "${key}" must be a string, number or boolean`,
  );
}

/** Accept an optional non-negative number of seconds to delay a step. */
function optionalDelay(value: unknown, step: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(
      `Step "${step}" key "delay" must be a non-negative number`,
    );
  }
  return value;
}

/** Accept an optional positive number of minutes after which a step times out. */
function optionalTimeoutMinutes(value: unknown, step: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      `Step "${step}" key "timeout-minutes" must be a positive number`,
    );
  }
  return value;
}

/** Accept a single port number or a list of them. */
function portList(value: unknown, step: string): number[] {
  if (value === undefined || value === null) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      throw new ConfigError(
        `Step "${step}" key "ports" must contain positive integers`,
      );
    }
    return item;
  });
}
