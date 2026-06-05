import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArgs,
  imageTag,
  type RunOptions,
  runArgs,
  splitCommand,
} from "../lib/docker.ts";
import type { Step } from "../lib/types.ts";

function step(partial: Partial<Step> & { name: string }): Step {
  return {
    service: false,
    depends: [],
    environment: [],
    ports: [],
    ...partial,
  };
}

test("imageTag uses the pulled image name, or a dockerci tag for builds", () => {
  assert.equal(imageTag(step({ name: "db", image: "postgres" })), "postgres");
  assert.equal(
    imageTag(step({ name: "test", dockerfile: "./D" })),
    "dockerci/test:latest",
  );
});

test("imageTag uses a referenced build step's generated image", () => {
  assert.equal(
    imageTag(step({ name: "test", image: "build", imageFrom: "build" })),
    "dockerci/build:latest",
  );
});

test("splitCommand splits on whitespace and handles empties", () => {
  assert.deepEqual(splitCommand("runtests"), ["runtests"]);
  assert.deepEqual(splitCommand("  npm   test "), ["npm", "test"]);
  assert.equal(splitCommand(undefined), undefined);
  assert.equal(splitCommand("   "), undefined);
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
