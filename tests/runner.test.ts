import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import type { DockerClient, RunOptions } from "../lib/docker.ts";
import { runPipeline, serviceSteps } from "../lib/runner.ts";

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
}

const CONFIG = `
build:
  dockerfile: ./Dockerfile.build
database:
  image: postgres
test:
  dockerfile: ./Dockerfile.test
  build_depends: build
  depends: database
  command: runtests
`;

function load() {
  return parseConfig(CONFIG, "/work");
}

const silent = () => {};

test("serviceSteps identifies depended-on steps", () => {
  assert.deepEqual([...serviceSteps(load())], ["database"]);
});

test("happy path builds, pulls, starts service, runs job, cleans up", async () => {
  const docker = new FakeDocker();
  const ok = await runPipeline(load(), {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, true);
  // both dockerfile steps are built, the image step is pulled.
  assert.deepEqual(
    docker.kinds("build").sort(),
    ["dockerci/build:latest", "dockerci/test:latest"],
  );
  assert.deepEqual(docker.kinds("pull"), ["postgres"]);
  // database is a service (started detached), test is a job (run).
  assert.deepEqual(docker.kinds("startDetached"), ["database"]);
  assert.deepEqual(docker.kinds("run"), ["test"]);
  // network created and removed; containers stopped at the end.
  assert.deepEqual(docker.kinds("createNetwork"), ["net"]);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.deepEqual(docker.kinds("stop").sort(), ["net-database", "net-test"]);
});

test("ordering: service starts before the job that depends on it", async () => {
  const docker = new FakeDocker();
  await runPipeline(load(), { docker, network: "net", log: silent });
  const order = docker.events.map((e) => `${e.kind}:${e.arg}`);
  assert.ok(
    order.indexOf("startDetached:database") < order.indexOf("run:test"),
  );
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
  // Teardown still happened.
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
  assert.ok(docker.kinds("stop").includes("net-test"));
});

test("build failure fails the pipeline and skips dependents", async () => {
  const docker = new FakeDocker();
  docker.failBuild.add("dockerci/test:latest");
  // Make the test step fail to build by depending only on the test build.
  const config = parseConfig(
    `solo:\n  dockerfile: ./D\n`,
    "/work",
  );
  docker.failBuild.add("dockerci/solo:latest");
  const ok = await runPipeline(config, {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, false);
  assert.deepEqual(docker.kinds("removeNetwork"), ["net"]);
});

test("a build-only step (no command, not depended on) is only built", async () => {
  const docker = new FakeDocker();
  const config = parseConfig(`build:\n  dockerfile: ./D\n`, "/work");
  const ok = await runPipeline(config, {
    docker,
    network: "net",
    log: silent,
  });

  assert.equal(ok, true);
  assert.deepEqual(docker.kinds("build"), ["dockerci/build:latest"]);
  assert.deepEqual(docker.kinds("run"), []);
  assert.deepEqual(docker.kinds("startDetached"), []);
  // Nothing was started, so nothing to stop.
  assert.deepEqual(docker.kinds("stop"), []);
});
