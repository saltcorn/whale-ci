import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import type { DockerClient, OutputSink, RunOptions } from "../lib/docker.ts";
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
  /** Container names that never reach their ready_on marker. */
  readyFail = new Set<string>();

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
  ): Promise<void> {
    this.events.push({ kind: "build", arg: tag });
    sink?.(`building ${tag}\n`);
    if (this.failBuild.has(tag)) {
      throw new Error(`build failed: ${tag}`);
    }
  }
  async pull(image: string, sink?: OutputSink): Promise<void> {
    this.events.push({ kind: "pull", arg: image });
    sink?.(`pulling ${image}\n`);
  }
  async run(options: RunOptions, sink?: OutputSink): Promise<number> {
    this.events.push({ kind: "run", arg: options.alias });
    this.runCommands.push(options.command);
    this.runImages.push(options.image);
    sink?.(`output of ${options.alias}\n`);
    return this.runExitCodes.get(options.alias) ?? 0;
  }
  async startDetached(options: RunOptions, sink?: OutputSink): Promise<void> {
    this.events.push({ kind: "startDetached", arg: options.alias });
    sink?.(`started ${options.alias}\n`);
  }
  async logs(name: string, sink?: OutputSink): Promise<void> {
    this.events.push({ kind: "logs", arg: name });
    sink?.(`logs of ${name}\n`);
  }
  async waitForReady(name: string, _needle: string): Promise<void> {
    this.events.push({ kind: "waitForReady", arg: name });
    if (this.readyFail.has(name)) {
      throw new Error(`never ready: ${name}`);
    }
  }
  async commit(container: string, tag: string): Promise<void> {
    this.events.push({ kind: "commit", arg: `${container}->${tag}` });
  }
  async removeImage(tag: string): Promise<void> {
    this.events.push({ kind: "removeImage", arg: tag });
  }
  async stop(name: string): Promise<void> {
    this.events.push({ kind: "stop", arg: name });
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
  ready_on: ready to accept connections
app:
  image: alpine
  depends: db
  command: run
`;

test("a dependent waits for the service's ready_on marker before starting", async () => {
  const docker = new FakeDocker();
  const { ok } = await runPipeline(parseConfig(READY_CONFIG, "/work"), {
    docker,
    ...base,
  });

  assert.equal(ok, true);
  // The service is started, then we wait for readiness, then the dependent runs.
  const start = docker.at("startDetached:db");
  const ready = docker.at("waitForReady:net-db");
  const runApp = docker.at("run:app");
  assert.ok(start !== -1 && ready !== -1 && runApp !== -1);
  assert.ok(start < ready, "service starts before we wait for readiness");
  assert.ok(ready < runApp, "dependent runs only after readiness");
});

test("a service that never reaches its ready_on marker fails the pipeline", async () => {
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

test("a service without ready_on is not waited on", async () => {
  // The README example's `database` service has no ready_on.
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, ...base });
  assert.deepEqual(docker.kinds("waitForReady"), []);
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

test("output is not captured unless requested", async () => {
  const docker = new FakeDocker();
  const { steps } = await runPipeline(load(), { docker, ...base });
  // No logs fetched and output buffers stay empty when not capturing.
  assert.deepEqual(docker.kinds("logs"), []);
  assert.ok(steps.every((s) => s.output === ""));
});
