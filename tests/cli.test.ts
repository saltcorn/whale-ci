import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/cli.ts";

test("parses a lone config file", () => {
  assert.deepEqual(parseArgs(["ci.yml"]), { help: false, configFile: "ci.yml" });
});

test("recognises --help and -h", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parses output flag in all spellings", () => {
  assert.equal(parseArgs(["-o", "r.html", "ci.yml"]).output, "r.html");
  assert.equal(parseArgs(["--output", "r.html", "ci.yml"]).output, "r.html");
  assert.equal(parseArgs(["--output=r.html", "ci.yml"]).output, "r.html");
  assert.equal(parseArgs(["-or.html", "ci.yml"]).output, "r.html");
});

test("output flag and config can appear in any order", () => {
  const parsed = parseArgs(["ci.yml", "-o", "r.html"]);
  assert.equal(parsed.configFile, "ci.yml");
  assert.equal(parsed.output, "r.html");
});

test("missing output value is an error", () => {
  assert.match(parseArgs(["-o"]).error!, /Missing value/);
});

test("unknown option is an error", () => {
  assert.match(parseArgs(["--bogus", "ci.yml"]).error!, /Unknown option/);
});

test("a second positional argument is an error", () => {
  assert.match(parseArgs(["a.yml", "b.yml"]).error!, /single config file/);
});
