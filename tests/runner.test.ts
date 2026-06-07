import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import type {
  DockerClient,
  LogFollower,
  OutputSink,
  RunOptions,
} from "../lib/docker.ts";
import { dependentsOf, runPipeline } from "../lib/runner.ts";

interface Event {
  kind: string;
  arg: string;
}

/** A DockerClient that records calls and lets tests script run exit codes. */
class FakeDocker implements DockerClient {
  events: Event[] = [];
  runExitCodes = new Map<string, number>();
  failBuild = new Set<string>();
  /** Container command argv captured per `run`, in call order. */
  runCommands: (string[] | undefined)[] = [];
  /** Image reference captured per `run`, in call order. */
  runImages: string[] = [];
  /** The most recent run/startDetached options for each step alias. */
  launched = new Map<string, RunOptions>();
  /** The `quiet` flag passed alongside each output-producing call, by alias. */
  quietByAlias = new Map<string, boolean>();
  /** Container names that never reach their ready-on marker. */
  readyFail = new Set<string>();
  /** Aliases whose `run` blocks until the container is force-stopped. */
  hangRun = new Set<string>();
  /** Called with the alias at the start of each `run` (e.g. to fire an interrupt). */
  onRun?: (alias: string) => void;
  #pendingRuns = new Map<string, (code: number) => void>();

  async createNetwork(name: string): Promise<void> {
    this.events.push({ kind: "createNetwork", arg: name });
  }
  async removeNetwork(name: string): Promise<void> {
    this.events.push({ kind: "removeNetwork", arg: name });
  }
  async build(
    tag: string,
    _dockerfile: string,
    _context: string,
    sink?: OutputSink,
    _quiet?: boolean,
  ): Promise<void> {
    this.events.push({ kind: "build", arg: tag });
    sink?.(`building ${tag}\n`);
    if (this.failBuild.has(tag)) {
      throw new Error(`build failed: ${tag}`);
    }
  }
  async pull(image: string, sink?: OutputSink, _quiet?: boolean): Promise<void> {
    this.events.push({ kind: "pull", arg: image });
    sink?.(`pulling ${image}\n`);
  }
  async run(
    options: RunOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<number> {
    this.events.push({ kind: "run", arg: options.alias });
    this.runCommands.push(options.command);
    this.runImages.push(options.image);
    this.launched.set(options.alias, options);
    this.quietByAlias.set(options.alias, quiet ?? false);
    sink?.(`output of ${options.alias}\n`);
    this.onRun?.(options.alias);
    if (this.hangRun.has(options.alias)) {
      // Block until `stop` is called for this container (the interrupt path).
      return await new Promise<number>((resolve) => {
        this.#pendingRuns.set(options.name, resolve);
      });
    }
    return this.runExitCodes.get(options.alias) ?? 0;
  }
  async startDetached(
    options: RunOptions,
    sink?: OutputSink,
    quiet?: boolean,
  ): Promise<void> {
    this.events.push({ kind: "startDetached", arg: options.alias });
    this.launched.set(options.alias, options);
    this.quietByAlias.set(options.alias, quiet ?? false);
    sink?.(`started ${options.alias}\n`);
  }
  followLogs(
    name: string,
    sink?: OutputSink,
    readyNeedle?: string,
    _quiet?: boolean,
  ): LogFollower {
    this.events.push({ kind: "followLogs", arg: name });
    // Simulate live output streaming as the follower attaches.
    sink?.(`logs of ${name}\n`);
    let ready: Promise<void>;
    if (readyNeedle !== undefined && this.readyFail.has(name)) {
      ready = Promise.reject(new Error(`never ready: ${name}`));
      ready.catch(() => {}); // avoid unhandled rejection when not awaited
    } else {
      ready = Promise.resolve();
    }
    return {
      ready,
      stop: async () => {
        this.events.push({ kind: "stopLogs", arg: name });
      },
    };
  }
  async commit(container: string, tag: string): Promise<void> {
    this.events.push({ kind: "commit", arg: `${container}->${tag}` });
  }
  async removeImage(tag: string): Promise<void> {
    this.events.push({ kind: "removeImage", arg: tag });
  }
  async stop(name: string): Promise<void> {
    this.events.push({ kind: "stop", arg: name });
    const resolve = this.#pendingRuns.get(name);
    if (resolve !== undefined) {
      this.#pendingRuns.delete(name);
      resolve(130);
    }
  }

  kinds(kind: string): string[] {
    return this.events.filter((e) => e.kind === kind).map((e) => e.arg);
  }
  /** Index of the first `kind:arg` event in recorded order, or -1. */
  at(label: string): number {
    return this.events.map((e) => `${e.kind}:${e.arg}`).indexOf(label);
  }
}

const CONFIG = `
build:
  dockerfile: ./Dockerfile.build
database:
  image: postgres
  service: true
test:
  dockerfile: ./Dockerfile.test
  depends:
    - build
    - database
  command: runtests
`;

function load() {
  return parseConfig(CONFIG, "/work");
}

const silent = () => {};
const base = { network: "net", log: silent };

test("dependentsOf maps each step to the steps that depend on it", () => {
  const deps = dependentsOf(load());
  assert.deepEqual([...deps.get("database")!], ["test"]);
  assert.deepEqual([...deps.get("build")!], ["test"]);
  assert.deepEqual([...deps.get("test")!], []);
});

test("happy path builds, pulls, starts service, runs job, cleans up", async () => {
  const docker = new FakeDocker();
  const { ok } = await runPipeline(load(), { docker, ...base });

  assert.equal(ok, true);
  // both dockerfile steps are built, the service image is pulled.
  assert.deepEqual(
    docker.kinds("build").sort(),
    ["dockerci/build:latest", "dockerci/test:latest"],
  );
  assert.deepEqual(docker.kinds("pull"), ["postgres"]);
  // database (service: true) is started detached; test (a job) is run.
  assert.deepEqual(docker.kinds("startDetached"), ["database"]);
  assert.deepEqual(docker.kinds("run"), ["test"]);
  assert.deepEqual(docker.kinds("createNetwork"), ["net"]);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("service starts before its dependent and is stopped once no longer required", async () => {
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, ...base });

  const startDb = docker.at("startDetached:database");
  const runTest = docker.at("run:test");
  const stopDb = docker.at("stop:net-database");
  // service running before the job, and stopped only after the job finished.
  assert.ok(startDb < runTest, "service should start before its dependent");
  assert.ok(stopDb > runTest, "service should stop after its dependent finishes");
});

test("a non-service dependency runs to completion before its dependent", async () => {
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, ...base });
  // `build` is a non-service dependency: its image must be built before `test` runs.
  const buildImg = docker.at("build:dockerci/build:latest");
  const runTest = docker.at("run:test");
  assert.ok(buildImg !== -1 && buildImg < runTest);
});

test("a service depended on by a service is torn down in reverse order", async () => {
  const config = parseConfig(
    `
db:
  image: postgres
  service: true
cache:
  image: redis
  service: true
  depends: db
app:
  image: alpine
  depends: cache
  command: run
`,
    "/work",
  );
  const docker = new FakeDocker();
  const { ok } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("startDetached"), ["db", "cache"]);
  assert.deepEqual(docker.kinds("run"), ["app"]);
  // app finishes -> cache no longer required -> db no longer required.
  const stopCache = docker.at("stop:net-cache");
  const stopDb = docker.at("stop:net-db");
  assert.ok(stopCache !== -1 && stopDb !== -1);
  assert.ok(stopCache < stopDb, "cache should stop before db");
});

test("a service that nothing depends on is never built or started", async () => {
  const config = parseConfig(
    `
orphan:
  image: redis
  service: true
job:
  image: alpine
  command: echo hi
`,
    "/work",
  );
  const docker = new FakeDocker();
  const { ok, steps } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("pull"), ["alpine"]);
  assert.deepEqual(docker.kinds("startDetached"), []);
  assert.deepEqual(docker.kinds("run"), ["job"]);
  assert.deepEqual(docker.kinds("stop"), []);
  // The skipped service still appears in the report, marked skipped.
  const orphan = steps.find((s) => s.name === "orphan")!;
  assert.equal(orphan.status, "skipped");
});

const READY_CONFIG = `
db:
  image: postgres
  service: true
  ready-on: ready to accept connections
app:
  image: alpine
  depends: db
  command: run
`;

test("a dependent waits for the service's ready-on marker before starting", async () => {
  const docker = new FakeDocker();
  const { ok } = await runPipeline(parseConfig(READY_CONFIG, "/work"), {
    docker,
    ...base,
  });

  assert.equal(ok, true);
  // The service is started, we follow its logs for the marker, then the
  // dependent runs only once readiness has been reached.
  const start = docker.at("startDetached:db");
  const follow = docker.at("followLogs:net-db");
  const runApp = docker.at("run:app");
  assert.ok(start !== -1 && follow !== -1 && runApp !== -1);
  assert.ok(start < follow, "service starts before we follow its output");
  assert.ok(follow < runApp, "dependent runs only after readiness");
});

test("a client reaches a service by its step name as the hostname", async () => {
  const config = parseConfig(
    `
database:
  image: postgres
  service: true
app:
  image: alpine
  depends: database
  environment:
    DB_HOST: database
  command: connect
`,
    "/work",
  );
  const docker = new FakeDocker();
  const { ok } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  // The service is published on the shared network under its step name...
  const database = docker.launched.get("database")!;
  assert.equal(database.network, "net");
  assert.equal(database.alias, "database");
  // ...and the client joins the same network with the step name as the host.
  const app = docker.launched.get("app")!;
  assert.equal(app.network, "net");
  assert.deepEqual(app.environment, ["DB_HOST=database"]);
});

test("a service that never reaches its ready-on marker fails the pipeline", async () => {
  const docker = new FakeDocker();
  docker.readyFail.add("net-db");
  const { ok, steps } = await runPipeline(parseConfig(READY_CONFIG, "/work"), {
    docker,
    ...base,
  });

  assert.equal(ok, false);
  // The dependent never starts, and the network is still torn down.
  assert.deepEqual(docker.kinds("run"), []);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.equal(steps.find((s) => s.name === "db")!.status, "failure");
});

test("a service's output is followed live, not dumped at the end", async () => {
  // The README example's `database` service has no ready-on, but its logs are
  // still followed live (so output streams as it happens) and the follow starts
  // right after the service is started, well before it is stopped.
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, ...base });
  assert.deepEqual(docker.kinds("followLogs"), ["net-database"]);
  assert.ok(
    docker.at("followLogs:net-database") < docker.at("stop:net-database"),
    "logs are followed while the service runs, not only when it stops",
  );
});

test("delay waits the configured seconds before the step runs", async () => {
  const config = parseConfig("job:\n  image: alpine\n  command: go\n  delay: 3", "/work");
  const docker = new FakeDocker();
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    // Record the delay relative to the docker calls made so far.
    docker.events.push({ kind: "sleep", arg: String(ms) });
  };
  const { ok } = await runPipeline(config, { docker, ...base, sleep });

  assert.equal(ok, true);
  // 3 seconds, expressed in milliseconds.
  assert.deepEqual(slept, [3000]);
  // The wait happens before the image is pulled and the command runs.
  assert.ok(docker.at("sleep:3000") < docker.at("pull:alpine"));
  assert.ok(docker.at("sleep:3000") < docker.at("run:job"));
});

test("steps without delay never sleep", async () => {
  const docker = new FakeDocker();
  const slept: number[] = [];
  await runPipeline(load(), {
    docker,
    ...base,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(slept, []);
});

test("a skipped service does not incur its delay", async () => {
  const config = parseConfig(
    `
orphan:
  image: redis
  service: true
  delay: 10
job:
  image: alpine
  command: go
`,
    "/work",
  );
  const docker = new FakeDocker();
  const slept: number[] = [];
  const { steps } = await runPipeline(config, {
    docker,
    ...base,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  // The orphan service is skipped, so its delay is never waited.
  assert.deepEqual(slept, []);
  assert.equal(steps.find((s) => s.name === "orphan")!.status, "skipped");
});

test("a step that exceeds its timeout-minutes fails and is torn down", async () => {
  const config = parseConfig(
    "job:\n  image: alpine\n  command: go\n  timeout-minutes: 2",
    "/work",
  );
  const docker = new FakeDocker();
  // The job never finishes on its own; the timeout must abort it.
  docker.hangRun.add("job");
  let scheduledMs = 0;
  const timer = (ms: number, fire: () => void) => {
    scheduledMs = ms;
    fire(); // the budget elapses while the job is still running
    return () => {};
  };
  const { ok, steps } = await runPipeline(config, { docker, ...base, timer });

  assert.equal(ok, false);
  // 2 minutes, expressed in milliseconds.
  assert.equal(scheduledMs, 120000);
  assert.equal(steps.find((s) => s.name === "job")!.status, "failure");
  // The abandoned container is force-stopped and the network removed.
  assert.deepEqual(docker.kinds("stop"), ["net-job"]);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("a step that completes within its timeout cancels the timer", async () => {
  const config = parseConfig(
    "job:\n  image: alpine\n  command: go\n  timeout-minutes: 5",
    "/work",
  );
  const docker = new FakeDocker();
  let cancelled = false;
  const timer = (_ms: number, _fire: () => void) => () => {
    cancelled = true;
  };
  const { ok, steps } = await runPipeline(config, { docker, ...base, timer });

  assert.equal(ok, true);
  assert.equal(steps.find((s) => s.name === "job")!.status, "success");
  assert.ok(cancelled, "the timeout timer is cancelled once the step finishes");
});

test("a step without timeout-minutes schedules no timer", async () => {
  const docker = new FakeDocker();
  let scheduled = 0;
  const timer = (_ms: number, _fire: () => void) => {
    scheduled++;
    return () => {};
  };
  await runPipeline(load(), { docker, ...base, timer });
  assert.equal(scheduled, 0);
});

test("aborting stops running containers and removes the network before returning", async () => {
  const config = parseConfig(
    `
db:
  image: postgres
  service: true
app:
  image: alpine
  depends: db
  command: serve
`,
    "/work",
  );
  const controller = new AbortController();
  const docker = new FakeDocker();
  // The app job runs indefinitely; fire the "Ctrl-C" once it is in flight.
  docker.hangRun.add("app");
  docker.onRun = (alias) => {
    if (alias === "app") queueMicrotask(() => controller.abort());
  };

  const { ok, steps } = await runPipeline(config, {
    docker,
    ...base,
    signal: controller.signal,
  });

  assert.equal(ok, false);
  // Both the running service and the interrupted job are stopped...
  assert.ok(docker.kinds("stop").includes("net-db"), "service stopped");
  assert.ok(docker.kinds("stop").includes("net-app"), "interrupted job stopped");
  // ...and the network is torn down before the run returns.
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.equal(steps.find((s) => s.name === "app")!.status, "failure");
});

test("an already-aborted signal stops the run and tears down", async () => {
  const docker = new FakeDocker();
  const { ok } = await runPipeline(load(), {
    docker,
    ...base,
    signal: AbortSignal.abort(),
  });
  // Nothing runs, but the network is still created and removed cleanly.
  assert.equal(ok, false);
  assert.deepEqual(docker.kinds("run"), []);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("non-zero job exit code fails the pipeline but still cleans up", async () => {
  const docker = new FakeDocker();
  docker.runExitCodes.set("test", 7);
  const { ok } = await runPipeline(load(), { docker, ...base });

  assert.equal(ok, false);
  // The service was never released by the failed job, so teardown stops it.
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.ok(docker.kinds("stop").includes("net-database"));
});

test("build failure fails the pipeline and still cleans up", async () => {
  const docker = new FakeDocker();
  const config = parseConfig("solo:\n  dockerfile: ./D\n", "/work");
  docker.failBuild.add("dockerci/solo:latest");
  const { ok } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, false);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("a build-only step (no command, not a service) is only built", async () => {
  const docker = new FakeDocker();
  const config = parseConfig("build:\n  dockerfile: ./D\n", "/work");
  const { ok } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("build"), ["dockerci/build:latest"]);
  assert.deepEqual(docker.kinds("run"), []);
  assert.deepEqual(docker.kinds("startDetached"), []);
  assert.deepEqual(docker.kinds("stop"), []);
});

test("a step whose image names a build step reuses it without pulling", async () => {
  const config = parseConfig(
    `
build:
  dockerfile: ./Dockerfile.build
test:
  image: build
  command: runtests
`,
    "/work",
  );
  const docker = new FakeDocker();
  const { ok } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  // Only the build step is built; nothing is pulled for `test`.
  assert.deepEqual(docker.kinds("build"), ["dockerci/build:latest"]);
  assert.deepEqual(docker.kinds("pull"), []);
  // `test` runs the generated image, after the build (the implicit dependency).
  const buildImg = docker.at("build:dockerci/build:latest");
  const runTest = docker.at("run:test");
  assert.ok(buildImg !== -1 && buildImg < runTest);
});

test("a list of commands runs each through the entrypoint, committing between them", async () => {
  const config = parseConfig(
    `
job:
  image: alpine
  command:
    - run-tests data
    - run-tests server
`,
    "/work",
  );
  const docker = new FakeDocker();
  const { ok, steps } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("pull"), ["alpine"]);
  // Each command runs as its own (bare argv) container, preserving the entrypoint.
  assert.deepEqual(docker.kinds("run"), ["job", "job"]);
  assert.deepEqual(docker.runCommands, [
    ["run-tests", "data"],
    ["run-tests", "server"],
  ]);
  // The second command builds on a snapshot of the first's filesystem.
  assert.deepEqual(docker.runImages, ["alpine", "net-job-snapshot0"]);
  assert.deepEqual(docker.kinds("commit"), ["net-job-cmd0->net-job-snapshot0"]);
  // Both per-command containers are removed and the snapshot image cleaned up.
  assert.deepEqual(docker.kinds("stop"), ["net-job-cmd0", "net-job-cmd1"]);
  assert.deepEqual(docker.kinds("removeImage"), ["net-job-snapshot0"]);
  assert.equal(steps.find((s) => s.name === "job")!.status, "success");
});

test("a single command runs as bare argv in a throwaway container", async () => {
  const config = parseConfig("job:\n  image: alpine\n  command: run tests", "/work");
  const docker = new FakeDocker();
  await runPipeline(config, { docker, ...base });
  assert.deepEqual(docker.runCommands, [["run", "tests"]]);
  // No commit / snapshot machinery for a single command.
  assert.deepEqual(docker.kinds("commit"), []);
  assert.deepEqual(docker.kinds("removeImage"), []);
});

test("a failing command stops the chain, fails the step and cleans up", async () => {
  const config = parseConfig(
    `
job:
  image: alpine
  command:
    - first
    - second
    - third
`,
    "/work",
  );
  const docker = new FakeDocker();
  // FakeDocker returns by alias, so the first `job` command fails immediately.
  docker.runExitCodes.set("job", 3);
  const { ok, steps } = await runPipeline(config, { docker, ...base });

  assert.equal(ok, false);
  // Only the first command runs; the remaining commands are skipped.
  assert.deepEqual(docker.kinds("run"), ["job"]);
  assert.deepEqual(docker.kinds("commit"), []);
  // The first command's container is still removed during teardown.
  assert.deepEqual(docker.kinds("stop"), ["net-job-cmd0"]);
  assert.equal(steps.find((s) => s.name === "job")!.status, "failure");
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("report records status, duration and captured output per step", async () => {
  const docker = new FakeDocker();
  const { steps } = await runPipeline(load(), {
    docker,
    ...base,
    captureOutput: true,
  });

  // Reported in config order, every step present including the service.
  assert.deepEqual(steps.map((s) => s.name), ["build", "database", "test"]);

  const byName = new Map(steps.map((s) => [s.name, s]));
  assert.equal(byName.get("build")!.status, "success");
  assert.equal(byName.get("database")!.service, true);
  assert.equal(byName.get("test")!.status, "success");

  // Service output includes its captured container logs.
  assert.match(byName.get("database")!.output, /started database/);
  assert.match(byName.get("database")!.output, /logs of net-database/);
  // Job output includes the command output.
  assert.match(byName.get("test")!.output, /output of test/);

  for (const step of steps) {
    assert.ok(step.durationMs >= 0);
  }
});

test("failed step is reported as failure", async () => {
  const docker = new FakeDocker();
  docker.runExitCodes.set("test", 2);
  const { steps } = await runPipeline(load(), {
    docker,
    ...base,
    captureOutput: true,
  });
  const t = steps.find((s) => s.name === "test")!;
  assert.equal(t.status, "failure");
});

test("a quiet step is run with the terminal echo suppressed but still captured", async () => {
  const config = parseConfig(
    "job:\n  image: alpine\n  command: go\n  quiet: true",
    "/work",
  );
  const docker = new FakeDocker();
  const { steps } = await runPipeline(config, {
    docker,
    ...base,
    captureOutput: true,
  });

  // The runner asks docker to suppress the terminal echo for this step...
  assert.equal(docker.quietByAlias.get("job"), true);
  // ...but the output is still captured into the report.
  assert.match(steps.find((s) => s.name === "job")!.output, /output of job/);
});

test("a non-quiet step runs with the terminal echo on", async () => {
  const config = parseConfig("job:\n  image: alpine\n  command: go", "/work");
  const docker = new FakeDocker();
  await runPipeline(config, { docker, ...base });
  assert.equal(docker.quietByAlias.get("job"), false);
});

test("output is not captured unless requested", async () => {
  const docker = new FakeDocker();
  const { steps } = await runPipeline(load(), { docker, ...base });
  // Logs are still followed live (streamed to the terminal), but with no sink
  // nothing is captured into the report.
  assert.deepEqual(docker.kinds("followLogs"), ["net-database"]);
  assert.ok(steps.every((s) => s.output === ""));
});
