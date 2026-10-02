// What a computation's module can reach in its cage.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { LANGUAGE } from "./language.ts";
import { Cage, compile } from "./workers.ts";

async function plan(body: string, inputs: unknown = {}, prelude = "") {
  const cage = new Cage("probe.js");
  try {
    await cage.load(compile("probe.js", `${prelude} export const reads = []; export const queries = {};
      export const plan = (inputs, seed) => { ${body} };
      export const finish = () => ({});`));
    return (await cage.ask({ inputs, seed: 7 })).jobs;
  } finally {
    cage.close();
  }
}

Deno.test("the cage holds the language and nothing of the host", async () => {
  assertEquals(
    await plan(`return ["Deno", "fetch", "WebAssembly", "Intl", "Temporal", "console", "setTimeout", "postMessage",
      "self", "navigator", "crypto", "WeakRef"].filter((n) => typeof globalThis[n] !== "undefined");`),
    [],
  );
  // Pruning the worker's global left the runtime's queueMicrotask behind.
  assertEquals(await plan(`return Object.getOwnPropertyNames(globalThis).sort();`), [...LANGUAGE].sort());
  // The language is SES's: what it does not permit, lockdown removes.
  assertEquals(await plan(`return [typeof RegExp.escape, typeof Error.isError, typeof Map.prototype.getOrInsert];`), [
    "undefined",
    "undefined",
    "undefined",
  ]);
  assertEquals(await plan(`return [Math.max(1, 2), new Date(0).toISOString(), JSON.stringify({ seed })];`), [
    2,
    "1970-01-01T00:00:00.000Z",
    '{"seed":7}',
  ]);
});

Deno.test("the clock and Math.random throw", async () => {
  for (const reach of ["Date.now()", "new Date()", "Date()", "new (new Date(0).constructor)()", "Math.random()"]) {
    await assertRejects(() => plan(`return ${reach};`), Error, "probe.js");
  }
  await assertRejects(() => plan("return Math.random();"), Error, "a computation's randomness is its seed");
});

Deno.test("the host's time zone and locale throw", async () => {
  // Removing Intl left them reachable: the engine answers local time and the
  // toLocale* family from its own data, so a module calling one wrote rows
  // that changed with the host's TZ and LANG.
  const d = "new Date(0)";
  for (
    const reach of [
      ...["getFullYear", "getYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds",
        "getMilliseconds", "getTimezoneOffset", "toString", "toDateString", "toTimeString", "toLocaleString",
        "toLocaleDateString", "toLocaleTimeString"].map((m) => `${d}.${m}()`),
      ...["setFullYear", "setYear", "setMonth", "setDate", "setHours", "setMinutes", "setSeconds", "setMilliseconds"]
        .map((m) => `${d}.${m}(1)`),
      `String(${d})`,
      `\`\${${d}}\``,
      "(1234.5).toLocaleString()",
      "(1n).toLocaleString()",
      "[1, 2].toLocaleString()",
      "new Float64Array([1]).toLocaleString()",
      '"a".localeCompare("b")',
      '"i".toLocaleUpperCase()',
      '"I".toLocaleLowerCase()',
      "new Date(2026, 0, 1)",
      'new Date("2026-01-01T10:00")',
      'new Date("Jan 1 2026")',
      'Date.parse("2026-01-01 10:00")',
      'Date.parse("2026-01-01T10:00:00")',
      // The constructor reads an object through ToPrimitive into the same
      // string; checking only a string argument let each of these parse local.
      'new Date(["2026-01-01T10:00"])',
      'new Date(new String("2026-01-01T10:00"))',
      'new Date({ toString() { return "2026-01-01T10:00"; } })',
      'new Date({ [Symbol.toPrimitive]: () => "2026-01-01T10:00" })',
    ]
  ) {
    await assertRejects(() => plan(`return ${reach};`), Error, "no time zone or locale", reach);
  }
});

Deno.test("a module reaches nothing of the cage through the intrinsics", async () => {
  // The cage once read these when a module called it, so a module that
  // replaced one first took the cage's checks apart: call made a local
  // string pass as a Date, construct handed out the host's Date with its
  // clock, exec placed every string.
  for (
    const attack of [
      `Function.prototype.call = function (self) { return self; };
        return new Date({ toString() { return "2026-01-01T10:00"; } }).getTime();`,
      "Reflect.construct = (target) => target; return new (new Date(0))().getTime();",
      "globalThis.Reflect = { construct: (target) => target }; return new (new Date(0))().getTime();",
      'RegExp.prototype.exec = () => []; return new Date("2026-01-01T10:00").getTime();',
    ]
  ) {
    await assertRejects(() => plan(attack), Error, "probe.js", attack);
  }
});

Deno.test("the intrinsics and the global object are frozen", async () => {
  assertEquals(
    await plan(`return [globalThis, Object.prototype, Function.prototype, Reflect, Math, JSON, Date, Date.prototype,
      RegExp.prototype, Array.prototype, String.prototype, Iterator.prototype, Object.getPrototypeOf(Int8Array)]
      .filter((o) => !Object.isFrozen(o)).length;`),
    0,
  );
  await assertRejects(() => plan("Reflect.construct = () => ({}); return [];"), Error, "read only");
});

Deno.test("UTC dates stay", async () => {
  assertEquals(
    await plan(`const d = new Date(Date.UTC(2026, 4, 24, 19));
      d.setUTCHours(20);
      return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay(), d.getUTCHours(), d.toISOString(),
        d.toUTCString(), JSON.stringify(d), d.getTime(), d.valueOf() === +d, Date.parse("2026-05-24"),
        Date.parse("2026-05-24T19:00:00.000Z"), new Date("2026-05-24T21:00+02:00").toISOString(),
        new Date(d).getTime(), [3, 1, 2].sort().join(), (255).toString(16)];`),
    [2026, 4, 24, 0, 20, "2026-05-24T20:00:00.000Z", "Sun, 24 May 2026 20:00:00 GMT", '"2026-05-24T20:00:00.000Z"',
      1779652800000, true, 1779580800000, 1779649200000, "2026-05-24T19:00:00.000Z", 1779652800000, "1,2,3", "ff"],
  );
});

Deno.test("a date's argument is converted once, as the language converts it", async () => {
  assertEquals(
    await plan(`let reads = 0;
      const once = new Date({ valueOf() { reads++; return 5; }, toString() { reads += 10; return ""; } }).getTime();
      return [once, reads, new Date(["2026-05-24"]).getTime(), new Date(new Date(7)).getTime(),
        new Date({ [Symbol.toPrimitive]: (hint) => hint === "default" ? 9 : 0 }).getTime()];`),
    [5, 1, 1779580800000, 7, 9],
  );
});

Deno.test("inputs are frozen", async () => {
  await assertRejects(() => plan(`inputs.game[0].id = "b"; return [];`, { game: [{ id: "a" }] }), Error, "read only");
  await assertRejects(() => plan(`inputs.game.push({}); return [];`, { game: [] }), Error);
});

Deno.test("a module exports exactly the contract", async () => {
  const cage = new Cage("extra.js");
  try {
    await assertRejects(
      () =>
        cage.load(compile("extra.js", `export const reads = []; export const queries = {}; export const plan = () => [];
          export const finish = () => ({}); export const compute = () => 1;`)),
      Error,
      "must export exactly finish, plan, queries, reads",
    );
  } finally {
    cage.close();
  }
});

Deno.test("a module imports nothing", async () => {
  // Loaded by the runtime, a module imported what no permission guards: the
  // runtime's built-ins handed it a clock (node:perf_hooks, node:timers), a
  // fresh realm's Date.now and Math.random (node:vm), and a channel out
  // (node:worker_threads).
  for (
    const specifier of ["node:perf_hooks", "node:vm", "node:timers", "node:worker_threads", "npm:ses@1.15.0",
      "./other.js", "file:///etc/hosts"]
  ) {
    const refused = `imports ${JSON.stringify(specifier)}: a computation is one file`;
    const cage = new Cage("import.js");
    try {
      await assertRejects(
        () => cage.load(compile("import.js", `import ${JSON.stringify(specifier)}; export const reads = [];`)),
        Error,
        `import.js ${refused}`,
      );
    } finally {
      cage.close();
    }
    assertEquals(
      await plan(`return [said];`, {}, `let said = "imported";
        import(${JSON.stringify(specifier)}).catch((e) => { said = e.message; });`),
      [`probe.js ${refused}`],
    );
  }
});

Deno.test("text SES's Compartment refuses fails the load, naming the file and the rule", async () => {
  // Valid ECMAScript each, and each crashed the service at startup: SES
  // rejects the text before evaluating it, and the module runs as a plain
  // function, where await is no keyword.
  for (
    const [text, rule] of [
      ["let n = 3; while (n --> 0) n;", "SES_HTML_COMMENT_REJECTED"],
      ['const tag = "<!--";', "SES_HTML_COMMENT_REJECTED"],
      ["// a computation calls no import(...)", "SES_IMPORT_REJECTED"],
      ["const sql = 'SELECT eval(1)';", "SES_EVAL_REJECTED"],
      ["await 1;", "await is only valid"],
    ]
  ) {
    await assertRejects(() => plan("return [];", {}, text), Error, "computation probe.js: SyntaxError", text);
    await assertRejects(() => plan("return [];", {}, text), Error, rule, text);
  }
  // Indirect eval is the language's: SES evaluates the text in the compartment.
  assertEquals(await plan(`return [(0, eval)("1 + 1"), Function("return 3")()];`), [2, 3]);
});

Deno.test("a module that does not parse fails as one the cage refuses", () => {
  // Babel's error escaped as a bare SyntaxError, naming neither the
  // computation nor the channel every other load failure comes by.
  assertThrows(() => compile("broken.js", "const x = ;"), Error, "computation broken.js: SyntaxError");
});
