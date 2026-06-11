import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArgs,
  firstFromImage,
  imageTag,
  rewriteBaseImage,
  type RunOptions,
  runArgs,
  splitCommand,
} from "../lib/docker.ts";
import type { Step } from "../lib/types.ts";

function step(partial: Partial<Step> & { name: string }): Step {
  return {
    runtime: "docker",
    service: false,
    depends: [],
    environment: [],
    ports: [],
    quiet: false,
    ...partial,
  };
}

test("imageTag uses the pulled image name, or a per-run dockerci tag for builds", () => {
  assert.equal(
    imageTag(step({ name: "db", image: "postgres" }), "run1"),
    "postgres",
  );
  assert.equal(
    imageTag(step({ name: "test", dockerfile: "./D" }), "run1"),
    "dockerci/test:run1",
  );
});

test("imageTag scopes built tags by run id so concurrent runs do not collide", () => {
  const built = step({ name: "test", dockerfile: "./D" });
  assert.equal(imageTag(built, "runA"), "dockerci/test:runA");
  assert.equal(imageTag(built, "runB"), "dockerci/test:runB");
});

test("imageTag uses a referenced build step's generated image", () => {
  assert.equal(
    imageTag(step({ name: "test", image: "build", imageFrom: "build" }), "run1"),
    "dockerci/build:run1",
  );
});

test("firstFromImage returns the image of the first FROM, ignoring comments and flags", () => {
  assert.equal(firstFromImage("FROM alpine"), "alpine");
  assert.equal(firstFromImage("# a comment\n\nFROM build AS stage"), "build");
  assert.equal(
    firstFromImage("FROM --platform=linux/amd64 build:1.2"),
    "build:1.2",
  );
  // ARG before FROM is legal; the first FROM still wins.
  assert.equal(firstFromImage("ARG V=1\nFROM base"), "base");
  assert.equal(firstFromImage("# only comments\n"), undefined);
});

test("rewriteBaseImage replaces only the first FROM's image, keeping flags and stage", () => {
  assert.equal(
    rewriteBaseImage("FROM build\nRUN make", "dockerci/build:run1"),
    "FROM dockerci/build:run1\nRUN make",
  );
  assert.equal(
    rewriteBaseImage(
      "FROM --platform=linux/amd64 build AS app\nRUN make",
      "dockerci/build:run1",
    ),
    "FROM --platform=linux/amd64 dockerci/build:run1 AS app\nRUN make",
  );
  // A later FROM (multi-stage) is left untouched.
  assert.equal(
    rewriteBaseImage("FROM build\nFROM build\n", "x"),
    "FROM x\nFROM build\n",
  );
  // No FROM: returned unchanged.
  assert.equal(rewriteBaseImage("RUN echo hi", "x"), "RUN echo hi");
});

test("splitCommand splits on whitespace and handles empties", () => {
  assert.deepEqual(splitCommand("runtests"), ["runtests"]);
  assert.deepEqual(splitCommand("  npm   test "), ["npm", "test"]);
  assert.equal(splitCommand(undefined), undefined);
  assert.equal(splitCommand("   "), undefined);
});

test("splitCommand honours shell-style quoting", () => {
  assert.deepEqual(
    splitCommand(`psql -d saltcorn_test --command='create extension "uuid-ossp";'`),
    ["psql", "-d", "saltcorn_test", `--command=create extension "uuid-ossp";`],
  );
  assert.deepEqual(splitCommand(`echo "a b" 'c d'`), ["echo", "a b", "c d"]);
  assert.deepEqual(splitCommand(`a\\ b`), ["a b"]);
  assert.deepEqual(splitCommand(`""`), [""]);
  assert.throws(() => splitCommand(`echo "unterminated`), /Unterminated double quote/);
});

test("buildArgs constructs a docker build invocation", () => {
  assert.deepEqual(buildArgs("dockerci/test:latest", "/w/D.test", "/w"), [
    "build",
    "-t",
    "dockerci/test:latest",
    "-f",
    "/w/D.test",
    "/w",
  ]);
});

test("runArgs builds foreground run with env and ports", () => {
  const options: RunOptions = {
    image: "postgres",
    name: "net-database",
    network: "net",
    alias: "database",
    environment: ["POSTGRES_HOST_AUTH_METHOD=trust"],
    ports: [5432],
  };
  assert.deepEqual(runArgs(options, false), [
    "run",
    "--rm",
    "-i",
    "--name",
    "net-database",
    "--network",
    "net",
    "--network-alias",
    "database",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "5432:5432",
    "postgres",
  ]);
});

test("runArgs omits --rm when keep is set so the container can be committed", () => {
  const options: RunOptions = {
    image: "alpine",
    name: "net-job-cmd0",
    network: "net",
    alias: "job",
    environment: [],
    ports: [],
    keep: true,
  };
  const args = runArgs(options, false);
  assert.ok(!args.includes("--rm"), "keep should drop --rm");
  assert.deepEqual(args.slice(0, 2), ["run", "-i"]);
});

test("runArgs builds detached run and appends the command", () => {
  const options: RunOptions = {
    image: "dockerci/test:latest",
    name: "net-test",
    network: "net",
    alias: "test",
    command: ["npm", "test"],
    environment: [],
    ports: [],
  };
  const args = runArgs(options, true);
  assert.ok(args.includes("-d"));
  assert.deepEqual(args.slice(-3), ["dockerci/test:latest", "npm", "test"]);
});
