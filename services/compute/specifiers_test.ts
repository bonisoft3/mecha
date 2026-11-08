// An app imports compute and durex through its own import map, so their
// npm and jsr dependencies are named by full specifier. A bare map entry
// beside them let mecha's tests load one version and the modules another.

import { assertEquals } from "@std/assert";

const services = new URL("../", import.meta.url);

async function texts(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) out.push(...await texts(new URL(`${entry.name}/`, dir)));
    else if (entry.isFile && entry.name.endsWith(".ts")) out.push(await Deno.readTextFile(new URL(entry.name, dir)));
  }
  return out;
}

Deno.test("each npm and jsr package compute and durex import names one version, and their maps name none", async () => {
  const versions = new Map<string, Set<string>>();
  const mapped: string[] = [];
  for (const service of ["compute", "durex"]) {
    for (const text of await texts(new URL(`${service}/`, services))) {
      for (const [, name, version] of text.matchAll(/["'](?:npm|jsr):((?:@[^/@"']+\/)?[^/@"']+)@([^/"']+)/g)) {
        versions.set(name, (versions.get(name) ?? new Set()).add(version));
      }
    }
    const config = JSON.parse(await Deno.readTextFile(new URL(`${service}/deno.json`, services)));
    mapped.push(...Object.keys(config.imports));
  }
  assertEquals([...versions].filter(([, v]) => v.size > 1).map(([name, v]) => `${name}: ${[...v].join(", ")}`), []);
  assertEquals(mapped.filter((name) => versions.has(name)), []);
});
