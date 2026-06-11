import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "cmd-ts";
import { app } from "../src/cli.ts";

/**
 * Parse argv with the cmd-ts command without running the handler, returning the
 * decoded `{ output, configFile }` object on success.
 */
async function parseArgs(args: string[]) {
  const result = await parse(app, args);
  assert.equal(result._tag, "ok", `expected a successful parse of ${JSON.stringify(args)}`);
  return (result as Extract<typeof result, { _tag: "ok" }>).value;
}

/** The concatenated error messages from a failed parse of `args`. */
async function parseError(args: string[]): Promise<string> {
  const result = await parse(app, args);
  assert.equal(result._tag, "error", `expected a failed parse of ${JSON.stringify(args)}`);
  return (result as Extract<typeof result, { _tag: "error" }>).error.errors
    .map((e) => e.message)
    .join("\n");
}

test("parses a lone config file", async () => {
  assert.deepEqual(await parseArgs(["ci.yml"]), {
    configFile: "ci.yml",
    output: undefined,
    serve: false,
    maxConcurrency: 4,
  });
});

test("parses --max-concurrency and defaults it to 4", async () => {
  assert.equal((await parseArgs(["ci.yml"])).maxConcurrency, 4);
  assert.equal(
    (await parseArgs(["--max-concurrency", "8", "ci.yml"])).maxConcurrency,
    8,
  );
  assert.equal(
    (await parseArgs(["ci.yml", "--max-concurrency=1"])).maxConcurrency,
    1,
  );
});

test("a non-numeric --max-concurrency is an error", async () => {
  assert.notEqual(
    (await parse(app, ["--max-concurrency", "lots", "ci.yml"]))._tag,
    "ok",
  );
});

test("a zero or negative --max-concurrency is an error", async () => {
  assert.match(
    await parseError(["--max-concurrency", "0", "ci.yml"]),
    /positive integer/,
  );
  assert.match(
    await parseError(["--max-concurrency", "-2", "ci.yml"]),
    /positive integer/,
  );
});

test("parses the --serve flag", async () => {
  assert.equal((await parseArgs(["ci.yml"])).serve, false);
  assert.equal((await parseArgs(["--serve", "ci.yml"])).serve, true);
  assert.equal((await parseArgs(["ci.yml", "--serve"])).serve, true);
});

test("parses output flag in all spellings", async () => {
  assert.equal((await parseArgs(["-o", "r.html", "ci.yml"])).output, "r.html");
  assert.equal((await parseArgs(["--output", "r.html", "ci.yml"])).output, "r.html");
  assert.equal((await parseArgs(["--output=r.html", "ci.yml"])).output, "r.html");
  assert.equal((await parseArgs(["-o=r.html", "ci.yml"])).output, "r.html");
});

test("output flag and config can appear in any order", async () => {
  const parsed = await parseArgs(["ci.yml", "-o", "r.html"]);
  assert.equal(parsed.configFile, "ci.yml");
  assert.equal(parsed.output, "r.html");
});

test("a missing config file is an error", async () => {
  assert.match(await parseError([]), /config\.yml/);
});

test("a missing output value is an error", async () => {
  assert.notEqual((await parse(app, ["-o"]))._tag, "ok");
});

test("an unknown option is an error", async () => {
  assert.match(await parseError(["--bogus", "ci.yml"]), /[Uu]nknown/);
});

test("a second positional argument is an error", async () => {
  assert.match(await parseError(["a.yml", "b.yml"]), /[Uu]nknown/);
});
