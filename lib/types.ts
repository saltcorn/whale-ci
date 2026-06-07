/**
 * A single CI step, as declared in one section of the YAML config file.
 *
 * Either `dockerfile` or `image` is always present (exactly one of them).
 * The array fields default to `[]` and `ports` is normalised during parsing so
 * consumers never have to handle the scalar shorthand.
 */
export interface Step {
  /** The section name, e.g. `build`, `database`, `test`. */
  name: string;
  /** Path to a Dockerfile to build, relative to the config file. */
  dockerfile?: string;
  /** Image to pull when there is no Dockerfile. */
  image?: string;
  /**
   * When `image` names another step that builds its own image, this holds that
   * step's name. The container then runs that step's generated image instead of
   * pulling from a registry, and an implicit dependency on it is added.
   */
  imageFrom?: string;
  /**
   * When true, the container runs in the background for as long as at least one
   * other step still depends on it, then is stopped. When false, the container
   * runs its command to completion before dependents proceed.
   */
  service: boolean;
  /**
   * Steps that must be ready before this step runs. A dependency that is a
   * service must be running; a dependency that is not a service must have
   * completed.
   */
  depends: string[];
  /**
   * Commands to run inside the container, as a list of command lines. A single
   * `command:` string is normalised to a one-element list. For a non-service
   * step the commands run sequentially, stopping (and failing the step) at the
   * first one that exits non-zero. A service step has at most one command.
   */
  command?: string[];
  /** Environment variables for the container, as `KEY=value` strings. */
  environment: string[];
  /** Ports to publish. */
  ports: number[];
  /**
   * Readiness marker for a service. When set, steps that depend on this one are
   * not started until this exact string has appeared in the service's output.
   * Only valid on a service step.
   */
  readyOn?: string;
  /**
   * Extra time to wait, in seconds, after all dependencies are ready and before
   * the step runs. Undefined means no extra delay.
   */
  delay?: number;
  /**
   * Maximum time, in minutes, the step's execution may take. If the step does
   * not complete within this many minutes it is aborted and fails. The configured
   * `delay` does not count against this budget. Undefined means no timeout.
   */
  timeoutMinutes?: number;
  /**
   * When true, the step's output is not echoed to the terminal. It is still
   * captured for the HTML report when output capture is enabled. Defaults to
   * false.
   */
  quiet: boolean;
}

/** A fully parsed and validated configuration file. */
export interface Config {
  /** Steps keyed by name, in the order they appear in the file. */
  steps: Map<string, Step>;
  /** Absolute directory containing the config file; build contexts resolve against it. */
  baseDir: string;
}

/** Raised for any problem with the configuration file (missing, malformed, invalid). */
export class ConfigError extends Error {
  override name = "ConfigError";
}
