import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import type { DockerClient, RunOptions } from "../lib/docker.ts";
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
  async build(tag: string): Promise<void> {
    this.events.push({ kind: "build", arg: tag });
    if (this.failBuild.has(tag)) {
      throw new Error(`build failed: ${tag}`);
    }
  }
  async pull(image: string): Promise<void> {
    this.events.push({ kind: "pull", arg: image });
  }
  async run(options: RunOptions): Promise<number> {
    this.events.push({ kind: "run", arg: options.alias });
    return this.runExitCodes.get(options.alias) ?? 0;
  }
  async startDetached(options: RunOptions): Promise<void> {
    this.events.push({ kind: "startDetached", arg: options.alias });
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

test("dependentsOf maps each step to the steps that depend on it", () => {
  const deps = dependentsOf(load());
  assert.deepEqual([...deps.get("database")!], ["test"]);
  assert.deepEqual([...deps.get("build")!], ["test"]);
  assert.deepEqual([...deps.get("test")!], []);
});

test("happy path builds, pulls, starts service, runs job, cleans up", async () => {
  const docker = new FakeDocker();
  const ok = await runPipeline(load(), {
    docker,
    network: "net",
    log: silent,
  });

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
  await runPipeline(load(), { docker, network: "net", log: silent });

  const startDb = docker.at("startDetached:database");
  const runTest = docker.at("run:test");
  const stopDb = docker.at("stop:net-database");
  // service running before the job, and stopped only after the job finished.
  assert.ok(startDb < runTest, "service should start before its dependent");
  assert.ok(stopDb > runTest, "service should stop after its dependent finishes");
});

test("a non-service dependency runs to completion before its dependent", async () => {
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, network: "net", log: silent });
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
  const ok = await runPipeline(config, { docker, network: "net", log: silent });

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
  const ok = await runPipeline(config, { docker, network: "net", log: silent });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("pull"), ["alpine"]);
  assert.deepEqual(docker.kinds("startDetached"), []);
  assert.deepEqual(docker.kinds("run"), ["job"]);
  assert.deepEqual(docker.kinds("stop"), []);
});

test("non-zero job exit code fails the pipeline but still cleans up", async () => {
  const docker = new FakeDocker();
  docker.runExitCodes.set("test", 7);
  const ok = await runPipeline(load(), {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, false);
  // The service was never released by the failed job, so teardown stops it.
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.ok(docker.kinds("stop").includes("net-database"));
});

test("build failure fails the pipeline and still cleans up", async () => {
  const docker = new FakeDocker();
  const config = parseConfig("solo:\n  dockerfile: ./D\n", "/work");
  docker.failBuild.add("dockerci/solo:latest");
  const ok = await runPipeline(config, {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, false);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("a build-only step (no command, not a service) is only built", async () => {
  const docker = new FakeDocker();
  const config = parseConfig("build:\n  dockerfile: ./D\n", "/work");
  const ok = await runPipeline(config, {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("build"), ["dockerci/build:latest"]);
  assert.deepEqual(docker.kinds("run"), []);
  assert.deepEqual(docker.kinds("startDetached"), []);
  assert.deepEqual(docker.kinds("stop"), []);
});
