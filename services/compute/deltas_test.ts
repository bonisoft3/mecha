import { assertEquals, assertThrows } from "@std/assert";
import { type DeltaRow, DeltaStore, GLOBAL_PARTITION } from "./deltas.ts";

const schema = { groups: "id", games: "group_id" };
const game = (id: string, group = "a", score = 0) => ({
  id,
  group_id: group,
  score,
});

Deno.test("delta partitions retain bag multiplicity and canonical identity", () => {
  const store = new DeltaStore(schema);
  assertEquals(
    store.bootstrap({ groups: [{ id: "a" }], games: [game("x"), game("x")] }),
    {
      keys: ["a"],
      records: 3,
      changedRows: 2,
    },
  );
  assertEquals(
    store.apply({
      games: [{ row: { score: 0, group_id: "a", id: "x" }, weight: -1 }],
    }),
    {
      keys: ["a"],
      records: 1,
      changedRows: 1,
    },
  );
  assertEquals(store.capture("a"), {
    groups: [{ id: "a" }],
    games: [game("x")],
  });
  assertThrows(
    () => store.bootstrap({ groups: [], games: [] }),
    Error,
    "already started",
  );
});

Deno.test("a complete step cancels transient rows regardless of record order", () => {
  const store = new DeltaStore(schema);
  store.bootstrap({ groups: [], games: [] });
  assertEquals(
    store.apply({
      games: [
        { row: game("x"), weight: -2 },
        { row: game("x"), weight: 1 },
        { row: game("x"), weight: 1 },
      ],
    }),
    { keys: [], records: 3, changedRows: 0 },
  );
  assertEquals(store.capture("a"), { groups: [], games: [] });
});

Deno.test("invalid final multiplicity rolls back every relation in the step", () => {
  const store = new DeltaStore(schema);
  store.bootstrap({ groups: [{ id: "a" }], games: [game("x")] });
  assertThrows(
    () =>
      store.apply({
        groups: [{ row: { id: "a" }, weight: -1 }],
        games: [{ row: game("x"), weight: -2 }],
      }),
    Error,
    "multiplicity",
  );
  assertEquals(store.capture("a"), {
    groups: [{ id: "a" }],
    games: [game("x")],
  });
  assertThrows(
    () =>
      store.apply({
        games: [{ row: game("x"), weight: Number.MAX_SAFE_INTEGER }],
      }),
    Error,
    "multiplicity",
  );
  assertEquals(store.capture("a").games, [game("x")]);
});

Deno.test("partition moves invalidate both owners and retain an empty tombstone", () => {
  const store = new DeltaStore(schema);
  store.bootstrap({ groups: [{ id: "a" }, { id: "b" }], games: [game("x")] });
  assertEquals(
    store.apply({
      groups: [{ row: { id: "a" }, weight: -1 }],
      games: [{ row: game("x"), weight: -1 }, {
        row: game("x", "b"),
        weight: 1,
      }],
    }).keys,
    ["a", "b"],
  );
  assertEquals(store.capture("a"), { groups: [], games: [] });
  assertEquals(store.capture("b"), {
    groups: [{ id: "b" }],
    games: [game("x", "b")],
  });
});

Deno.test("capture remains immutable after incoming mutation and subsequent steps", () => {
  const store = new DeltaStore({ result: "group" });
  const row = { group: "a", values: [{ value: 1 }] };
  store.bootstrap({ result: [row] });
  row.values[0].value = 99;
  const captured = store.capture("a");
  assertEquals(captured, { result: [{ group: "a", values: [{ value: 1 }] }] });
  assertThrows(() => {
    (captured.result as DeltaRow[]).push({});
  }, TypeError);
  assertThrows(() => {
    (captured.result[0].values as { value: number }[])[0].value = 5;
  }, TypeError);
  store.apply({
    result: [{ row: { group: "a", values: [{ value: 1 }] }, weight: -1 }],
  });
  assertEquals(captured.result.length, 1);
  assertEquals(store.capture("a"), { result: [] });
});

Deno.test("unrelated history does not change work or captured input for an isolated delta", () => {
  const outcomes = [0, 10000].map((unrelated) => {
    const store = new DeltaStore(schema);
    store.bootstrap({
      groups: [
        { id: "a" },
        ...Array.from({ length: unrelated }, (_, i) => ({ id: `other-${i}` })),
      ],
      games: [
        game("x"),
        ...Array.from(
          { length: unrelated },
          (_, i) => game(`other-${i}`, `other-${i}`),
        ),
      ],
    });
    const changes = store.apply({
      games: [{ row: game("x"), weight: -1 }, {
        row: game("x", "a", 3),
        weight: 1,
      }],
    });
    return { changes, input: store.capture("a") };
  });
  assertEquals(outcomes[0], outcomes[1]);
  assertEquals(outcomes[0].changes, {
    keys: ["a"],
    records: 2,
    changedRows: 2,
  });
});

Deno.test("empty global bootstrap runs once and complete retraction captures empty inputs", () => {
  const store = new DeltaStore({ left: null, right: null });
  assertEquals(store.bootstrap({ left: [], right: [] }), {
    keys: [GLOBAL_PARTITION],
    records: 0,
    changedRows: 0,
  });
  store.apply({ left: [{ row: { value: 2 }, weight: 1 }] });
  assertEquals(
    store.apply({ left: [{ row: { value: 2 }, weight: -1 }] }).keys,
    [GLOBAL_PARTITION],
  );
  assertEquals(store.capture(GLOBAL_PARTITION), { left: [], right: [] });
  assertThrows(() => store.capture("other"), Error, "partition");
});

Deno.test("delta admission refuses invalid keys, weights, values and implicit broadcasts", () => {
  assertThrows(() => new DeltaStore({}), Error, "requires relations");
  assertThrows(
    () => new DeltaStore({ a: null, b: "id" }),
    Error,
    "dependency mapping",
  );
  const store = new DeltaStore(schema);
  assertThrows(
    () => store.bootstrap({ groups: [] }),
    Error,
    "every declared relation",
  );
  for (const weight of [0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assertThrows(
      () => store.apply({ games: [{ row: game("x"), weight }] }),
      Error,
      "weight",
    );
  }
  assertThrows(
    () => store.apply({ games: [{ row: { group_id: null }, weight: 1 }] }),
    Error,
    "partition key",
  );
  assertThrows(
    () => store.apply({ unknown: [] }),
    Error,
    "unknown delta relation",
  );
  for (const value of [undefined, NaN, Infinity, 1n, new Date()]) {
    assertThrows(
      () =>
        store.apply({ games: [{ row: { ...game("x"), value }, weight: 1 }] }),
      Error,
      "finite JSON",
    );
  }
  const row: DeltaRow = game("x");
  row.self = row;
  assertThrows(
    () => store.apply({ games: [{ row, weight: 1 }] }),
    Error,
    "acyclic",
  );
  assertEquals(store.bootstrap({ groups: [], games: [] }).keys, []);
});

Deno.test("capture ordering and field names are deterministic without prototype setters", () => {
  const store = new DeltaStore(JSON.parse('{"__proto__":"id"}'));
  store.bootstrap(
    JSON.parse('{"__proto__":[{"id":"a","value":2},{"value":1,"id":"a"}]}'),
  );
  assertEquals(
    store.capture("a"),
    JSON.parse('{"__proto__":[{"id":"a","value":1},{"id":"a","value":2}]}'),
  );
});
