import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseConfig,
  resolveDockerfileBases,
  restrictToStep,
} from "../lib/config.ts";
import { ConfigError } from "../lib/types.ts";

/** Build a Dockerfile reader from a path-suffix -> contents map. */
function reader(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    for (const [suffix, text] of Object.entries(files)) {
      if (path.endsWith(suffix)) return text;
    }
    throw new Error(`no such file: ${path}`);
  };
}

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

test("a Dockerfile FROM naming another build step links it as the base image", async () => {
  const config = parseConfig(
    `
base:
  dockerfile: ./Dockerfile.base
app:
  dockerfile: ./Dockerfile.app
  command: runtests
`,
    "/w",
  );
  await resolveDockerfileBases(
    config,
    reader({
      "Dockerfile.base": "FROM alpine\nRUN apk add make",
      "Dockerfile.app": "FROM base\nRUN make",
    }),
  );
  const app = config.steps.get("app")!;
  assert.equal(app.baseFrom, "base");
  assert.deepEqual(app.depends, ["base"]);
  // The base step itself builds FROM a registry image, so it has no baseFrom.
  assert.equal(config.steps.get("base")!.baseFrom, undefined);
});

test("a base link does not duplicate an existing explicit dependency", async () => {
  const config = parseConfig(
    `
base:
  dockerfile: ./Dockerfile.base
app:
  dockerfile: ./Dockerfile.app
  depends: base
  command: runtests
`,
    "/w",
  );
  await resolveDockerfileBases(
    config,
    reader({
      "Dockerfile.base": "FROM alpine",
      "Dockerfile.app": "FROM base",
    }),
  );
  assert.deepEqual(config.steps.get("app")!.depends, ["base"]);
});

test("a FROM that names no build step is left to be pulled", async () => {
  const config = parseConfig("app:\n  dockerfile: ./D\n", "/w");
  await resolveDockerfileBases(config, reader({ "D": "FROM node:22" }));
  assert.equal(config.steps.get("app")!.baseFrom, undefined);
  assert.deepEqual(config.steps.get("app")!.depends, []);
});

test("a FROM that names a pull-only step is not linked as a base", async () => {
  // `cache` only pulls an image; it has no generated image to build on.
  const config = parseConfig(
    "cache:\n  image: redis\napp:\n  dockerfile: ./D\n",
    "/w",
  );
  await resolveDockerfileBases(config, reader({ "D": "FROM cache" }));
  assert.equal(config.steps.get("app")!.baseFrom, undefined);
  assert.deepEqual(config.steps.get("app")!.depends, []);
});

test("base links that form a cycle are rejected", async () => {
  const config = parseConfig(
    "a:\n  dockerfile: ./Da\nb:\n  dockerfile: ./Db\n",
    "/w",
  );
  await assert.rejects(
    () =>
      resolveDockerfileBases(
        config,
        reader({ "Da": "FROM b", "Db": "FROM a" }),
      ),
    /cycle/,
  );
});

test("an unreadable Dockerfile is skipped, leaving its FROM to be pulled", async () => {
  const config = parseConfig(
    "base:\n  dockerfile: ./Dockerfile.base\napp:\n  dockerfile: ./missing\n",
    "/w",
  );
  // Only the base Dockerfile is readable; app's is missing at resolve time.
  await resolveDockerfileBases(
    config,
    reader({ "Dockerfile.base": "FROM alpine" }),
  );
  assert.equal(config.steps.get("app")!.baseFrom, undefined);
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

test("ready-on is parsed onto a service step", () => {
  const yaml = `
db:
  image: postgres
  service: true
  ready-on: ready to accept connections
`;
  const db = parseConfig(yaml, "/w").steps.get("db")!;
  assert.equal(db.readyOn, "ready to accept connections");
});

test("ready-on defaults to undefined", () => {
  const a = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(a.readyOn, undefined);
});

test("ready-on requires the step to be a service", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  ready-on: up", "/w"),
    /sets "ready-on" but is not a service/,
  );
});

test("ready-on must be a string", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  service: true\n  ready-on: 5", "/w"),
    /key "ready-on" must be a string/,
  );
});

test("only-if is parsed as a string and defaults to undefined", () => {
  const withCheck = parseConfig(
    "a:\n  image: x\n  only-if: test -f go.mod",
    "/w",
  ).steps.get("a")!;
  assert.equal(withCheck.onlyIf, "test -f go.mod");
  const without = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(without.onlyIf, undefined);
});

test("only-if must be a string", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  only-if: 5", "/w"),
    /key "only-if" must be a string/,
  );
});

test("push is parsed with its image, tag and only-if subkeys", () => {
  const yaml = `
a:
  dockerfile: ./Dockerfile
  push:
    image: myorg/myapp
    tag: $(git rev-parse --short HEAD)
    only-if: test "$BRANCH" = main
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.push, {
    image: "myorg/myapp",
    tag: ["$(git rev-parse --short HEAD)"],
    onlyIf: 'test "$BRANCH" = main',
  });
});

test("push tag accepts a list of strings", () => {
  const yaml = `
a:
  dockerfile: ./Dockerfile
  push:
    image: myorg/myapp
    tag:
      - latest
      - $(git rev-parse --short HEAD)
`;
  const a = parseConfig(yaml, "/w").steps.get("a")!;
  assert.deepEqual(a.push!.tag, ["latest", "$(git rev-parse --short HEAD)"]);
});

test("push defaults to undefined, with optional tag and only-if", () => {
  const without = parseConfig("a:\n  dockerfile: ./d", "/w").steps.get("a")!;
  assert.equal(without.push, undefined);
  const minimal = parseConfig(
    "a:\n  dockerfile: ./d\n  push:\n    image: myorg/myapp",
    "/w",
  ).steps.get("a")!;
  assert.deepEqual(minimal.push, {
    image: "myorg/myapp",
    tag: undefined,
    onlyIf: undefined,
  });
});

test("push must be a mapping with an image", () => {
  assert.throws(
    () => parseConfig("a:\n  dockerfile: ./d\n  push: myorg/myapp", "/w"),
    /key "push" must be a mapping/,
  );
  assert.throws(
    () => parseConfig("a:\n  dockerfile: ./d\n  push:\n    tag: v1", "/w"),
    /key "push" must set "image"/,
  );
});

test("push rejects unknown subkeys and non-string values", () => {
  assert.throws(
    () =>
      parseConfig(
        "a:\n  dockerfile: ./d\n  push:\n    image: x\n    repo: y",
        "/w",
      ),
    /key "push" has unknown key "repo"/,
  );
  assert.throws(
    () =>
      parseConfig(
        "a:\n  dockerfile: ./d\n  push:\n    image: x\n    tag: 5",
        "/w",
      ),
    /key "push.tag" must be a string or list of strings/,
  );
  assert.throws(
    () =>
      parseConfig(
        "a:\n  dockerfile: ./d\n  push:\n    image: x\n    tag: [v1, 5]",
        "/w",
      ),
    /key "push.tag" must contain only strings/,
  );
});

test("push requires the step to build from a dockerfile", () => {
  assert.throws(
    () => parseConfig("a:\n  image: alpine\n  push:\n    image: x", "/w"),
    /sets "push" but has no "dockerfile"/,
  );
});

test("delay is parsed as a number of seconds and defaults to undefined", () => {
  const withDelay = parseConfig("a:\n  image: x\n  delay: 5", "/w").steps.get("a")!;
  assert.equal(withDelay.delay, 5);
  const without = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(without.delay, undefined);
});

test("delay accepts a fractional value", () => {
  const a = parseConfig("a:\n  image: x\n  delay: 0.5", "/w").steps.get("a")!;
  assert.equal(a.delay, 0.5);
});

test("delay rejects negative and non-numeric values", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  delay: -1", "/w"),
    /key "delay" must be a non-negative number/,
  );
  assert.throws(
    () => parseConfig("a:\n  image: x\n  delay: soon", "/w"),
    /key "delay" must be a non-negative number/,
  );
});

test("timeout-minutes is parsed as a number and defaults to undefined", () => {
  const withTimeout = parseConfig("a:\n  image: x\n  timeout-minutes: 5", "/w")
    .steps.get("a")!;
  assert.equal(withTimeout.timeoutMinutes, 5);
  const without = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(without.timeoutMinutes, undefined);
});

test("timeout-minutes accepts a fractional value", () => {
  const a = parseConfig("a:\n  image: x\n  timeout-minutes: 0.5", "/w")
    .steps.get("a")!;
  assert.equal(a.timeoutMinutes, 0.5);
});

test("timeout-minutes rejects non-positive and non-numeric values", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  timeout-minutes: 0", "/w"),
    /key "timeout-minutes" must be a positive number/,
  );
  assert.throws(
    () => parseConfig("a:\n  image: x\n  timeout-minutes: -1", "/w"),
    /key "timeout-minutes" must be a positive number/,
  );
  assert.throws(
    () => parseConfig("a:\n  image: x\n  timeout-minutes: soon", "/w"),
    /key "timeout-minutes" must be a positive number/,
  );
});

test("quiet is parsed and defaults to false", () => {
  const quiet = parseConfig("a:\n  image: x\n  quiet: true", "/w").steps.get("a")!;
  assert.equal(quiet.quiet, true);
  const loud = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(loud.quiet, false);
});

test("quiet must be a boolean", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  quiet: yes", "/w"),
    /key "quiet" must be true or false/,
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

test("runtime is parsed and defaults to docker", () => {
  const incus = parseConfig("a:\n  image: images:debian/12\n  runtime: incus", "/w")
    .steps.get("a")!;
  assert.equal(incus.runtime, "incus");
  const plain = parseConfig("a:\n  image: x", "/w").steps.get("a")!;
  assert.equal(plain.runtime, "docker");
  const explicit = parseConfig("a:\n  image: x\n  runtime: docker", "/w")
    .steps.get("a")!;
  assert.equal(explicit.runtime, "docker");
});

test("runtime rejects values other than docker or incus", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  runtime: podman", "/w"),
    /key "runtime" must be "docker" or "incus"/,
  );
});

test("an incus step cannot be a service", () => {
  assert.throws(
    () => parseConfig("a:\n  image: x\n  runtime: incus\n  service: true", "/w"),
    /uses the incus runtime and cannot be a service/,
  );
});

test("an incus step cannot build from a dockerfile", () => {
  assert.throws(
    () => parseConfig("a:\n  dockerfile: ./D\n  runtime: incus", "/w"),
    /uses the incus runtime and cannot build from a "dockerfile"/,
  );
});

test("an incus step cannot depend on a service", () => {
  const yaml = `
db:
  image: postgres
  service: true
job:
  image: images:debian/12
  runtime: incus
  depends: db
`;
  assert.throws(
    () => parseConfig(yaml, "/w"),
    /Step "job" uses the incus runtime and cannot depend on service "db"/,
  );
});

test("an incus step may depend on (and be depended on by) docker jobs", () => {
  const yaml = `
build:
  dockerfile: ./D
job:
  image: images:debian/12
  runtime: incus
  depends: build
  command: run
verify:
  image: alpine
  depends: job
  command: check
`;
  const config = parseConfig(yaml, "/w");
  assert.deepEqual(config.steps.get("job")!.depends, ["build"]);
  assert.deepEqual(config.steps.get("verify")!.depends, ["job"]);
});

test("an incus step's image is never resolved to a build step's image", () => {
  // For a docker step, `image: build` would reuse the build step's generated
  // image; an incus step cannot run a docker image, so the name is left alone.
  const yaml = `
build:
  dockerfile: ./D
job:
  image: build
  runtime: incus
  command: run
`;
  const job = parseConfig(yaml, "/w").steps.get("job")!;
  assert.equal(job.imageFrom, undefined);
  assert.deepEqual(job.depends, []);
});

test("restrictToStep keeps the step and its transitive dependencies", () => {
  const yaml = `
base:
  image: alpine
build:
  image: x
  depends: base
test:
  image: y
  depends: build
lint:
  image: z
docs:
  image: w
  depends: lint
`;
  const config = restrictToStep(parseConfig(yaml, "/w"), "test");
  assert.deepEqual([...config.steps.keys()], ["base", "build", "test"]);
  assert.equal(config.baseDir, "/w");
});

test("restrictToStep on a step with no dependencies keeps only that step", () => {
  const yaml = `
a:
  image: x
b:
  image: y
  depends: a
`;
  const config = restrictToStep(parseConfig(yaml, "/w"), "a");
  assert.deepEqual([...config.steps.keys()], ["a"]);
});

test("restrictToStep handles diamond dependencies without duplication", () => {
  const yaml = `
base:
  image: x
left:
  image: y
  depends: base
right:
  image: z
  depends: base
top:
  image: w
  depends:
    - left
    - right
`;
  const config = restrictToStep(parseConfig(yaml, "/w"), "top");
  assert.deepEqual([...config.steps.keys()], ["base", "left", "right", "top"]);
});

test("restrictToStep follows implicit image-reference dependencies", () => {
  const yaml = `
build:
  dockerfile: ./D
test:
  image: build
  command: runtests
other:
  image: q
`;
  const config = restrictToStep(parseConfig(yaml, "/w"), "test");
  assert.deepEqual([...config.steps.keys()], ["build", "test"]);
});

test("restrictToStep rejects an unknown step name", () => {
  const config = parseConfig(README_EXAMPLE, "/w");
  assert.throws(
    () => restrictToStep(config, "missing"),
    (err: unknown) =>
      err instanceof ConfigError &&
      /Unknown step "missing"/.test(err.message) &&
      /build, database, test/.test(err.message),
  );
});
