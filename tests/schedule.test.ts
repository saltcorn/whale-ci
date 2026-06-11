import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import { runScheduled } from "../lib/schedule.ts";
import type { Step } from "../lib/types.ts";

const GRAPH = `
build:
  dockerfile: ./D.build
database:
  image: postgres
  service: true
test:
  dockerfile: ./D.test
  depends:
    - build
    - database
`;

test("processes every step exactly once, respecting dependencies", async () => {
  const config = parseConfig(GRAPH, "/w");
  const order: string[] = [];

  const completed = await runScheduled(config, async (step: Step) => {
    order.push(step.name);
  });

  assert.deepEqual(completed.sort(), ["build", "database", "test"]);
  // test must come after both its prerequisites.
  assert.ok(order.indexOf("test") > order.indexOf("build"));
  assert.ok(order.indexOf("test") > order.indexOf("database"));
});

test("runs independent steps concurrently", async () => {
  const config = parseConfig(GRAPH, "/w");
  let active = 0;
  let maxActive = 0;

  await runScheduled(config, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  });

  // build and database have no prerequisites and should overlap.
  assert.ok(maxActive >= 2, `expected concurrency, got ${maxActive}`);
});

test("caps concurrent non-service steps at maxConcurrency", async () => {
  // Five independent jobs, limited to two in flight at a time.
  const config = parseConfig(
    ["a", "b", "c", "d", "e"]
      .map((name) => `${name}:\n  image: img\n  command: run-${name}`)
      .join("\n"),
    "/w",
  );
  let active = 0;
  let maxActive = 0;

  const completed = await runScheduled(
    config,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    },
    undefined,
    2,
  );

  assert.equal(completed.length, 5);
  assert.ok(maxActive <= 2, `expected at most 2 in flight, got ${maxActive}`);
  assert.ok(maxActive === 2, `expected the limit to be reached, got ${maxActive}`);
});

test("service steps do not count toward maxConcurrency", async () => {
  // The service's process call stays in flight until both jobs have run. With
  // a limit of one, the jobs can only run if the service is not counted.
  const config = parseConfig(
    `
svc:
  image: redis
  service: true
a:
  image: img
  command: run-a
b:
  image: img
  command: run-b
`,
    "/w",
  );
  let jobsRun = 0;
  let release!: () => void;
  const allJobsDone = new Promise<void>((r) => {
    release = r;
  });

  await runScheduled(
    config,
    async (step: Step) => {
      if (step.service) {
        await allJobsDone;
        return;
      }
      jobsRun += 1;
      if (jobsRun === 2) release();
    },
    undefined,
    1,
  );

  assert.equal(jobsRun, 2);
});

test("does not start dependents after a failure and propagates the error", async () => {
  const config = parseConfig(GRAPH, "/w");
  const processed: string[] = [];

  await assert.rejects(
    runScheduled(config, async (step: Step) => {
      processed.push(step.name);
      if (step.name === "build") {
        throw new Error("build blew up");
      }
      await new Promise((r) => setTimeout(r, 5));
    }),
    /build blew up/,
  );

  // test depends on build, so it must never have been processed.
  assert.ok(!processed.includes("test"));
});

test("maxConcurrency is shared jointly across docker and incus steps", async () => {
  // Two docker jobs and two incus jobs, limited to two in flight: the cap
  // counts every non-service step regardless of its runtime, so there is one
  // shared budget rather than one per runtime.
  const config = parseConfig(
    `
a:
  image: img
  command: run-a
b:
  image: img
  command: run-b
c:
  image: images:debian/12
  runtime: incus
  command: run-c
d:
  image: images:debian/12
  runtime: incus
  command: run-d
`,
    "/w",
  );
  let active = 0;
  let maxActive = 0;

  const completed = await runScheduled(
    config,
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    },
    undefined,
    2,
  );

  assert.equal(completed.length, 4);
  assert.equal(maxActive, 2, `expected exactly 2 in flight, got ${maxActive}`);
});
