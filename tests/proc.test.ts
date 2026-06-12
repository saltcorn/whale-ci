import assert from "node:assert/strict";
import { test } from "node:test";
import { execTool } from "../lib/proc.ts";

test("execTool closes stdin so a child that reads it to EOF does not hang", async () => {
  // `incus launch` reads instance config from stdin when it is not a terminal;
  // an open pipe left unclosed would block it forever. `cat` exhibits the same
  // read-to-EOF behavior, so it stands in for incus here.
  let output = "";
  const code = await execTool("bash", ["-c", "cat; echo done"], {
    sink: (chunk) => {
      output += chunk;
    },
    quiet: true,
  });
  assert.equal(code, 0);
  assert.equal(output, "done\n");
});

test("execTool feeds input to the child's stdin when given", async () => {
  let output = "";
  const code = await execTool("cat", [], {
    input: "hello\n",
    sink: (chunk) => {
      output += chunk;
    },
    quiet: true,
  });
  assert.equal(code, 0);
  assert.equal(output, "hello\n");
});
