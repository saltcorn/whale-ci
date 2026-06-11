import assert from "node:assert/strict";
import { test } from "node:test";
import {
  execArgs,
  instanceName,
  launchArgs,
  proxyDeviceArgs,
} from "../lib/incus.ts";

test("launchArgs launches an ephemeral instance from the image", () => {
  assert.deepEqual(
    launchArgs({ image: "images:debian/12", name: "net-job", ports: [] }),
    ["launch", "images:debian/12", "net-job", "--ephemeral"],
  );
});

test("proxyDeviceArgs publishes a port on all host interfaces", () => {
  assert.deepEqual(proxyDeviceArgs("net-job", 8080), [
    "config",
    "device",
    "add",
    "net-job",
    "port8080",
    "proxy",
    "listen=tcp:0.0.0.0:8080",
    "connect=tcp:127.0.0.1:8080",
  ]);
});

test("execArgs passes environment flags before the -- command", () => {
  assert.deepEqual(
    execArgs("net-job", ["run", "tests"], ["FOO=bar", "BAZ=qux"]),
    ["exec", "net-job", "--env", "FOO=bar", "--env", "BAZ=qux", "--", "run", "tests"],
  );
  assert.deepEqual(execArgs("net-job", ["sh"], []), ["exec", "net-job", "--", "sh"]);
});

test("instanceName sanitises names incus would reject", () => {
  // Valid names pass through untouched.
  assert.equal(instanceName("dockerci-123-job"), "dockerci-123-job");
  // Characters outside [a-zA-Z0-9-] become hyphens (docker allows _ and .).
  assert.equal(instanceName("net-my_step.x"), "net-my-step-x");
  // Must start with a letter and must not end with a hyphen.
  assert.equal(instanceName("1net-job"), "i1net-job");
  assert.equal(instanceName("net-job_"), "net-job");
  // At most 63 characters.
  assert.equal(instanceName(`j${"x".repeat(100)}`).length, 63);
});
