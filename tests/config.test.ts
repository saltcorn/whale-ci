import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import { ConfigError } from "../lib/types.ts";

const README_EXAMPLE = `
build:
    dockerfile: ./Dockerfile.build

database:
    image: postgres
    service: true
    environment:
       POSTGRES_HOST_AUTH_METHOD: trust
    ports: 5432

test:
    dockerfile: ./Dockerfile.test
    depends:
      - build
      - database
    command: runtests
`;

test("parses the README example into normalised steps", () => {
  const config = parseConfig(README_EXAMPLE, "/work");
  assert.equal(config.baseDir, "/work");
  assert.deepEqual([...config.steps.keys()], ["build", "database", "test"]);

  const build = config.steps.get("build")!;
  assert.equal(build.dockerfile, "./Dockerfile.build");
  assert.equal(build.image, undefined);
  assert.equal(build.service, false);
  assert.deepEqual(build.depends, []);

  const database = config.steps.get("database")!;
  assert.equal(database.image, "postgres");
  assert.equal(database.service, true);
  assert.deepEqual(database.environment, ["POSTGRES_HOST_AUTH_METHOD=trust"]);
  assert.deepEqual(database.ports, [5432]);

  const t = config.steps.get("test")!;
  assert.equal(t.service, false);
  assert.deepEqual(t.depends, ["build", "database"]);
  assert.deepEqual(t.command, ["runtests"]);
});

test("service defaults to false and rejects non-boolean values", () => {
  assert.equal(parseConfig("a:\n  image: x", "/w").steps.get("a")!.service, false);
  assert.throws(
    () => parseConfig("a:\n  image: x\n  service: yes", "/w"),
    /must be true or false/,
  );
});

test("build_depends is no longer a recognised key", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  build_depends: b\nb:\n  image: y", "/w"),
    /unknown key "build_depends"/,
  );
});

test("rejects empty config", () => {
  assert.throws(() => parseConfig("", "/w"), ConfigError);
  assert.throws(() => parseConfig("# just a comment", "/w"), ConfigError);
});

test("rejects non-mapping top level", () => {
  assert.throws(() => parseConfig("- a\n- b", "/w"), ConfigError);
});

test("requires exactly one of dockerfile / image", () => {
  assert.throws(
    () => parseConfig("a:\n  command: x", "/w"),
    /must set either/,
  );
  assert.throws(
    () => parseConfig("a:\n  image: x\n  dockerfile: ./D", "/w"),
    /cannot set both/,
  );
});

test("rejects unknown keys", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  bogus: 1", "/w"),
    /unknown key "bogus"/,
  );
});

test("rejects dependency on unknown step", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  depends: missing", "/w"),
    /unknown step "missing"/,
  );
});

test("rejects self dependency", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  depends: a", "/w"),
    /cannot depend on itself/,
  );
});

test("detects dependency cycles", () => {
  const yaml = `
a:
  image: x
  depends: b
b:
  image: y
  depends: c
c:
  image: z
  depends: a
`;
  assert.throws(() => parseConfig(yaml, "/w"), /cycle/);
});

test("accepts a longer acyclic graph", () => {
  const yaml = `
a:
  image: x
b:
  image: y
  depends: a
c:
  image: z
  depends:
    - a
    - b
`;
  const config = parseConfig(yaml, "/w");
  assert.equal(config.steps.size, 3);
});

test("an image matching a build step links to it and adds an implicit dependency", () => {
  const yaml = `
build:
  dockerfile: ./Dockerfile.build
test:
  image: build
  command: runtests
`;
  const config = parseConfig(yaml, "/w");
  const test = config.steps.get("test")!;
  assert.equal(test.imageFrom, "build");
  assert.deepEqual(test.depends, ["build"]);
});

test("an existing explicit dependency is not duplicated when linking images", () => {
  const yaml = `
build:
  dockerfile: ./Dockerfile.build
test:
  image: build
  depends: build
  command: runtests
`;
  const test = parseConfig(yaml, "/w").steps.get("test")!;
  assert.equal(test.imageFrom, "build");
  assert.deepEqual(test.depends, ["build"]);
});

test("an image that does not match a build step is left to be pulled", () => {
  // `postgres` is not a step name, so it is pulled from the registry as before.
  const a = parseConfig("a:\n  image: postgres", "/w").steps.get("a")!;
  assert.equal(a.imageFrom, undefined);
  assert.deepEqual(a.depends, []);
});

test("an image matching a non-build (pull-only) step is not linked", () => {
  // `db` only pulls an image; it has no generated image to reuse.
  const yaml = `
db:
  image: postgres
a:
  image: db
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.equal(a.imageFrom, undefined);
  assert.deepEqual(a.depends, []);
});

test("image links that form a cycle are rejected", () => {
  const yaml = `
a:
  dockerfile: ./Da
  depends: b
b:
  image: a
`;
  assert.throws(() => parseConfig(yaml, "/w"), /cycle/);
});

test("normalises a single command string to a one-element list", () => {
  const a = parseConfig("a:\n  image: x\n  command: runtests", "/w").steps.get("a")!;
  assert.deepEqual(a.command, ["runtests"]);
});

test("accepts a list of commands", () => {
  const yaml = `
a:
  image: x
  command:
    - npm ci
    - npm test
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.command, ["npm ci", "npm test"]);
});

test("an empty command list means no command", () => {
  const a = parseConfig("a:\n  image: x\n  command: []", "/w").steps.get("a")!;
  assert.equal(a.command, undefined);
});

test("rejects non-string entries in a command list", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  command:\n    - 1", "/w"),
    /command" must contain only strings/,
  );
});

test("a service may not have multiple commands", () => {
  const yaml = `
a:
  image: x
  service: true
  command:
    - one
    - two
`;
  assert.throws(() => parseConfig(yaml, "/w"), /cannot run multiple commands/);
});

test("a service may have a single command", () => {
  const yaml = `
a:
  image: x
  service: true
  command:
    - serve
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.command, ["serve"]);
});

test("a disabled step is completely ignored", () => {
  const yaml = `
build:
  dockerfile: ./Dockerfile.build
scratch:
  image: alpine
  disable: true
`;
  const config = parseConfig(yaml, "/w");
  assert.deepEqual([...config.steps.keys()], ["build"]);
  assert.equal(config.steps.has("scratch"), false);
});

test("disable: false leaves the step in the pipeline", () => {
  const a = parseConfig("a:\n  image: x\n  disable: false", "/w").steps.get("a")!;
  assert.ok(a);
});

test("a disabled step need not be otherwise valid", () => {
  // No dockerfile/image, which would normally be required; ignored when disabled.
  const config = parseConfig("a:\n  image: x\nstub:\n  disable: true", "/w");
  assert.deepEqual([...config.steps.keys()], ["a"]);
});

test("disable must be a boolean", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  disable: yes", "/w"),
    /key "disable" must be true or false/,
  );
});

test("depending on a disabled step is an unknown-step error", () => {
  const yaml = `
build:
  dockerfile: ./D
  disable: true
test:
  image: x
  depends: build
`;
  assert.throws(() => parseConfig(yaml, "/w"), /depends on unknown step "build"/);
});

test("a config with every step disabled has no steps", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  disable: true", "/w"),
    /at least one step/,
  );
});

test("ready_on is parsed onto a service step", () => {
  const yaml = `
db:
  image: postgres
  service: true
  ready_on: ready to accept connections
`;
  const db = parseConfig(yaml, "/w").steps.get("db")!;
  assert.equal(db.readyOn, "ready to accept connections");
});

test("ready_on defaults to undefined", () => {
  const a = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(a.readyOn, undefined);
});

test("ready_on requires the step to be a service", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  ready_on: up", "/w"),
    /sets "ready_on" but is not a service/,
  );
});

test("ready_on must be a string", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  service: true\n  ready_on: 5", "/w"),
    /key "ready_on" must be a string/,
  );
});

test("normalises a single port and a list of ports", () => {
  const single = parseConfig("a:\n  image: x\n  ports: 80", "/w").steps.get("a")!;
  assert.deepEqual(single.ports, [80]);

  const many = parseConfig("a:\n  image: x\n  ports:\n    - 80\n    - 443", "/w")
    .steps.get("a")!;
  assert.deepEqual(many.ports, [80, 443]);
});

test("parses environment as a mapping, coercing scalars to strings", () => {
  const yaml = `
a:
  image: x
  environment:
    POSTGRES_HOST_AUTH_METHOD: trust
    PORT: 5432
    DEBUG: true
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.environment, [
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "PORT=5432",
    "DEBUG=true",
  ]);
});

test("parses environment as a list of KEY=value strings", () => {
  const yaml = `
a:
  image: x
  environment:
    - FOO=bar
    - BAZ=qux
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.environment, ["FOO=bar", "BAZ=qux"]);
});

test("environment defaults to empty and rejects nested values", () => {
  assert.deepEqual(
    parseConfig("a:\n  image: x", "/w").steps.get("a")!.environment,
    [],
  );
  assert.throws(
    () => parseConfig("a:\n  image: x\n  environment:\n    K:\n      nested: 1", "/w"),
    /environment value for "K"/,
  );
});

test("rejects non-integer ports", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  ports: notaport", "/w"),
    /positive integers/,
  );
});
