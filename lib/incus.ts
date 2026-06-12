import { execTool, type OutputSink } from "./proc.ts";

/** Options describing how to launch a step's incus instance. */
export interface IncusLaunchOptions {
  /** Incus image reference to launch, e.g. `images:debian/12`. */
  image: string;
  /** Instance name. */
  name: string;
  /** Ports to publish on the host, via proxy devices. */
  ports: number[];
}

/**
 * The incus operations the runner needs. Abstracted behind an interface (like
 * {@link import("./docker.ts").DockerClient}) so the orchestration can be
 * tested without a real incus daemon.
 *
 * Incus has no Dockerfile-style build and its instances are system containers
 * that keep running on their own, so the model is simpler than docker's: launch
 * an ephemeral instance once, exec each command inside it (the filesystem
 * persists between commands naturally), and delete it when the step is done.
 */
export interface IncusClient {
  /**
   * Launch an ephemeral instance from an image (pulling the image first if
   * needed) and publish its ports, resolving once it is running and its
   * network is up (it has been assigned an IPv4 address — waited on for up to
   * a minute, since DHCP/DNS configuration lags the instance start).
   */
  launch(
    options: IncusLaunchOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<void>;
  /**
   * Run a command inside a running instance, resolving with its exit code.
   * `environment` is a list of `KEY=value` strings.
   */
  exec(
    name: string,
    command: string[],
    environment: string[],
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<number>;
  /** Force-stop and delete an instance by name; never rejects. */
  delete(name: string): Promise<void>;
}

/**
 * Make a container name safe to use as an incus instance name: only ASCII
 * letters, digits and hyphens, starting with a letter, not ending with a
 * hyphen, at most 63 characters.
 */
export function instanceName(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9-]/g, "-");
  if (!/^[a-zA-Z]/.test(safe)) safe = `i${safe}`;
  return safe.slice(0, 63).replace(/-+$/, "");
}

/** Build the argv for `incus launch`. */
export function launchArgs(options: IncusLaunchOptions): string[] {
  // Ephemeral instances are deleted on stop, so a crashed run leaves nothing
  // behind once the instance goes down.
  return ["launch", options.image, options.name, "--ephemeral"];
}

/** Build the argv adding a proxy device that publishes `port` on the host. */
export function proxyDeviceArgs(name: string, port: number): string[] {
  return [
    "config",
    "device",
    "add",
    name,
    `port${port}`,
    "proxy",
    `listen=tcp:0.0.0.0:${port}`,
    `connect=tcp:127.0.0.1:${port}`,
  ];
}

/**
 * Build the argv listing just an instance's IPv4 column, in CSV format. The
 * name is anchored because `incus list` treats its filter as a pattern that
 * would otherwise also match instances whose names share the prefix.
 */
export function listAddressArgs(name: string): string[] {
  return ["list", `^${name}$`, "--format", "csv", "--columns", "4"];
}

/** True when `incus list` CSV output shows an assigned IPv4 address. */
export function hasIpv4Address(output: string): boolean {
  return /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(output);
}

/** Build the argv for `incus exec`. */
export function execArgs(
  name: string,
  command: string[],
  environment: string[],
): string[] {
  const args = ["exec", name];
  for (const env of environment) {
    args.push("--env", env);
  }
  args.push("--", ...command);
  return args;
}

/** An IncusClient that shells out to the real `incus` binary. */
export class CliIncusClient implements IncusClient {
  readonly #incus: string;

  constructor(incus = "incus") {
    this.#incus = incus;
  }

  async launch(
    options: IncusLaunchOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<void> {
    await execTool(this.#incus, launchArgs(options), { sink, quiet });
    for (const port of options.ports) {
      await execTool(this.#incus, proxyDeviceArgs(options.name, port), {
        sink,
        quiet,
      });
    }
    await this.#waitForNetwork(options.name);
  }

  /**
   * Wait for the instance's network to come up before the first command runs.
   * `incus launch` returns as soon as the instance has started, which is
   * before DHCP has assigned it an address or configured DNS — a command run
   * immediately would find a half-configured network ("could not resolve
   * host"). An assigned IPv4 address signals the DHCP exchange is done (the
   * lease carries the DNS configuration with it). Gives up after a minute so
   * an instance that never gets an address still runs its commands, which can
   * then fail with their own, clearer error if they actually need the network.
   */
  async #waitForNetwork(name: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      let output = "";
      await execTool(this.#incus, listAddressArgs(name), {
        allowNonZero: true,
        quiet: true,
        sink: (chunk) => {
          output += chunk;
        },
      });
      if (hasIpv4Address(output)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async exec(
    name: string,
    command: string[],
    environment: string[],
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<number> {
    return await execTool(this.#incus, execArgs(name, command, environment), {
      allowNonZero: true,
      sink,
      quiet,
    });
  }

  async delete(name: string): Promise<void> {
    try {
      await execTool(this.#incus, ["delete", "-f", name], { quiet: true });
    } catch {
      // Best effort during teardown.
    }
  }
}
