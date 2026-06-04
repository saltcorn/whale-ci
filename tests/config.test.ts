import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../lib/config.ts";
import { ConfigError } from "../lib/types.ts";

const README_EXAMPLE = `
build:
    dockerfile: ./Dockerfile.build

database:
    image: postgres
    volumes:
       - "pgdata:/var/lib/postgresql/data"
    ports: 5432

test:
    dockerfile: ./Dockerfile.test
    build_depends:
      - build
    depends:
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
  assert.deepEqual(build.build_depends, []);

  const database = config.steps.get("database")!;
  assert.equal(database.image, "postgres");
  assert.deepEqual(database.volumes, ["pgdata:/var/lib/postgresql/data"]);
  assert.deepEqual(database.ports, [5432]);

  const t = config.steps.get("test")!;
  assert.deepEqual(t.build_depends, ["build"]);
  assert.deepEqual(t.depends, ["database"]);
  assert.equal(t.command, "runtests");
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
  build_depends: a
c:
  image: z
  depends:
    - a
    - b
`;
  const config = parseConfig(yaml, "/w");
  assert.equal(config.steps.size, 3);
});

test("normalises scalar volumes and list ports", () => {
  const yaml = `
a:
  image: x
  volumes: data:/data
  ports:
    - 80
    - 443
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.volumes, ["data:/data"]);
  assert.deepEqual(a.ports, [80, 443]);
});

test("rejects non-integer ports", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  ports: notaport", "/w"),
    /positive integers/,
  );
});
