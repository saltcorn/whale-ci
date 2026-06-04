import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Config, ConfigError, type Step } from "./types.ts";

/** Keys that are accepted inside a step section. Anything else is an error. */
const KNOWN_KEYS = new Set([
  "dockerfile",
  "image",
  "build_depends",
  "depends",
  "command",
  "volumes",
  "ports",
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
    steps.set(name, parseStep(name, raw));
  }

  if (steps.size === 0) {
    throw new ConfigError("Config file must define at least one step");
  }

  validateReferences(steps);
  detectCycles(steps);

  return { steps, baseDir };
}

/** Validate and normalise a single step section. */
function parseStep(name: string, raw: unknown): Step {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`Step "${name}" must be a mapping`);
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

  return {
    name,
    dockerfile,
    image,
    build_depends: stringList(raw["build_depends"], name, "build_depends"),
    depends: stringList(raw["depends"], name, "depends"),
    command: optionalString(raw["command"], name, "command"),
    volumes: stringList(raw["volumes"], name, "volumes"),
    ports: portList(raw["ports"], name),
  };
}

/** Ensure every build_depends/depends target names a real step. */
function validateReferences(steps: Map<string, Step>): void {
  for (const step of steps.values()) {
    for (const dep of [...step.build_depends, ...step.depends]) {
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
 * Detect dependency cycles across the combined build_depends + depends graph
 * using an iterative depth-first search.
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
      const deps = [...step.build_depends, ...step.depends];
      let pushed = false;
      for (const dep of deps) {
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
