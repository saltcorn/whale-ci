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
test:
  dockerfile: ./D.test
  build_depends: build
  depends: database
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
