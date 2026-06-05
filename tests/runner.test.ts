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
