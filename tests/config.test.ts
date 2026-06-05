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
  assert.equal(t.command, "runtests");
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
