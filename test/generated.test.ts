// src/generated/ is what contract/orbtr-v1.json generates: a change to the contract lands with its
// regenerated files, and a hand edit of a generated file fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { repoRoot } from "./helpers.js";

test("src/generated matches the contract", async () => {
  const gen = (await import(pathToFileURL(join(repoRoot, "scripts", "generate.mjs")).href)) as {
    generate: (c: unknown) => { types: string; resources: string };
  };
  const contract = JSON.parse(readFileSync(join(repoRoot, "contract", "orbtr-v1.json"), "utf8"));
  const out = gen.generate(contract);
  assert.equal(readFileSync(join(repoRoot, "src", "generated", "types.ts"), "utf8"), out.types);
  assert.equal(readFileSync(join(repoRoot, "src", "generated", "resources.ts"), "utf8"), out.resources);
});

test("every contract operation is a method of the client", async () => {
  const { Orbtr } = await import("../src/index.js");
  const client = new Orbtr({ apiKey: "k", fetch: (async () => new Response("{}")) as typeof fetch }) as unknown as Record<
    string,
    unknown
  >;
  const contract = JSON.parse(readFileSync(join(repoRoot, "contract", "orbtr-v1.json"), "utf8")) as {
    paths: Record<string, Record<string, { "x-orbtr-resource": string; "x-orbtr-method": string; "x-orbtr-stream"?: unknown }>>;
  };
  for (const item of Object.values(contract.paths)) {
    for (const op of Object.values(item)) {
      let target: unknown = client;
      for (const seg of op["x-orbtr-resource"].split(".")) target = (target as Record<string, unknown>)[seg];
      const methods = [op["x-orbtr-method"], ...(op["x-orbtr-stream"] ? ["stream"] : [])];
      for (const m of methods) {
        assert.equal(typeof (target as Record<string, unknown>)[m], "function", `${op["x-orbtr-resource"]}.${m}`);
      }
    }
  }
});
