// The licence's use grant names ORBTR's Terms of Service by its address, and the package ships the licence.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "./helpers.js";

test("the use grant links ORBTR's Terms of Service and the package ships the licence", () => {
  const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");
  assert.match(license, /USE GRANT\.[\s\S]*Terms of Service \(https:\/\/orbtr\.ai\/terms\)/);
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { license: string; files: string[] };
  assert.equal(pkg.license, "SEE LICENSE IN LICENSE");
  assert.ok(pkg.files.includes("LICENSE"));
});
