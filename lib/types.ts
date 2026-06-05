/**
 * A single CI step, as declared in one section of the YAML config file.
 *
 * Either `dockerfile` or `image` is always present (exactly one of them).
 * The array fields default to `[]` and `volumes`/`ports` are normalised
 * during parsing so consumers never have to handle the scalar shorthand.
 */
export interface Step {
  /** The section name, e.g. `build`, `database`, `test`. */
  name: string;
  /** Path to a Dockerfile to build, relative to the config file. */
  dockerfile?: string;
  /** Image to pull when there is no Dockerfile. */
  image?: string;
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
  /** Command to run inside the container. */
  command?: string;
  /** Environment variables for the container, as `KEY=value` strings. */
  environment: string[];
  /** Volume mounts, e.g. `pgdata:/var/lib/postgresql/data`. */
  volumes: string[];
  /** Ports to publish. */
  ports: number[];
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
