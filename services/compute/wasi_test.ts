import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { runWasm } from "./wasi.ts";

// A hand-assembled WASI command: echo stdin, then 16 random_get bytes and the
// realtime clock to stdout, "oops" to stderr; a first stdin byte of 'e' exits
// 7, 't' traps, 'x' calls an unprovided import.
const I32 = 0x7f, I64 = 0x7e;
const uleb = (n: number): number[] =>
	n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...uleb(n >>> 7)];
const sleb = (n: number): number[] =>
	n >= -64 && n < 64 ? [n & 0x7f] : [(n & 0x7f) | 0x80, ...sleb(n >> 7)];
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const name = (s: string) =>
	vec([...new TextEncoder().encode(s)].map((b) => [b]));
const section = (
	id: number,
	body: number[],
) => [id, ...uleb(body.length), ...body];
const func = (
	params: number[],
	results: number[],
) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const i32 = (n: number) => [0x41, ...sleb(n)];
const store = (
	address: number,
	value: number[],
) => [...i32(address), ...value, 0x36, 2, 0];
const call = (f: number, ...args: number[][]) => [...args.flat(), 0x10, f];
const iov = (
	at: number,
	base: number,
	length: number[],
) => [...store(at, i32(base)), ...store(at + 4, length)];
const firstByteIs = (
	c: string,
	body: number[],
) => [
	...i32(64),
	0x2d,
	0,
	0,
	...i32(c.charCodeAt(0)),
	0x46,
	0x04,
	0x40,
	...body,
	0x0b,
];
const [
	FD_READ,
	FD_WRITE,
	PROC_EXIT,
	RANDOM_GET,
	CLOCK_TIME_GET,
	SOCK_SHUTDOWN,
] = [0, 1, 2, 3, 4, 5];
const start = [
	...iov(0, 64, i32(1024)),
	...call(FD_READ, i32(0), i32(0), i32(1), i32(8)),
	0x1a,
	...firstByteIs("e", call(PROC_EXIT, i32(7))),
	...firstByteIs("t", [0x00]),
	...firstByteIs("x", [...call(SOCK_SHUTDOWN, i32(0), i32(0)), 0x1a]),
	...store(4, [...i32(8), 0x28, 2, 0]),
	...call(FD_WRITE, i32(1), i32(0), i32(1), i32(12)),
	0x1a,
	...call(RANDOM_GET, i32(2000), i32(16)),
	0x1a,
	...call(CLOCK_TIME_GET, i32(0), [0x42, 0], i32(2016)),
	0x1a,
	...iov(16, 2000, i32(24)),
	...call(FD_WRITE, i32(1), i32(16), i32(1), i32(12)),
	0x1a,
	...iov(24, 3000, i32(4)),
	...call(FD_WRITE, i32(2), i32(24), i32(1), i32(12)),
	0x1a,
	0x0b,
];
const wasi = (
	field: string,
	type: number,
) => [...name("wasi_snapshot_preview1"), ...name(field), 0, type];
const module = new WebAssembly.Module(
	new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		1,
		0,
		0,
		0,
		...section(
			1,
			vec([
				func([I32, I32, I32, I32], [I32]),
				func([I32], []),
				func([I32, I32], [I32]),
				func([I32, I64, I32], [I32]),
				func([], []),
			]),
		),
		...section(
			2,
			vec([
				wasi("fd_read", 0),
				wasi("fd_write", 0),
				wasi("proc_exit", 1),
				wasi("random_get", 2),
				wasi("clock_time_get", 3),
				wasi("sock_shutdown", 2),
			]),
		),
		...section(3, vec([[4]])),
		...section(5, vec([[0, 1]])),
		...section(7, vec([[...name("memory"), 2, 0], [...name("_start"), 0, 6]])),
		...section(10, vec([[...uleb(start.length + 1), 0, ...start]])),
		...section(11, vec([[0, ...i32(3000), 0x0b, ...name("oops")]])),
	]),
);

const text = (s: string) => new TextEncoder().encode(s);

Deno.test("stdin is echoed to stdout; random bytes are fixed and the clock reads 0", () => {
	const out = runWasm(module, text("hello"), "golaberto-odds");
	assertEquals(new TextDecoder().decode(out.subarray(0, 5)), "hello");
	assertEquals(out.length, 5 + 16 + 8);
	assertNotEquals([...out.subarray(5, 21)], new Array(16).fill(0));
	assertEquals([...out.subarray(21)], new Array(8).fill(0));
});

Deno.test("each run is a fresh instance with the same random stream", () => {
	assertEquals(runWasm(module, text("a"), "golaberto-odds"), runWasm(module, text("a"), "golaberto-odds"));
});

Deno.test("a nonzero exit throws with stderr", () => {
	assertThrows(() => runWasm(module, text("e"), "golaberto-odds"), Error, "wasm exited with 7: ");
});

Deno.test("a trap throws with stderr so far", () => {
	assertThrows(() => runWasm(module, text("t"), "golaberto-odds"), Error, "wasm trapped: ");
});

Deno.test("an import outside the shim traps naming itself", () => {
	assertThrows(
		() => runWasm(module, text("x"), "golaberto-odds"),
		Error,
		"wasi_snapshot_preview1.sock_shutdown is not provided",
	);
});

// A WASI command that writes its argv[0], NUL included, to stdout.
const argv0 = [
	...call(1, i32(0), i32(4)),
	0x1a,
	...call(2, i32(8), i32(100)),
	0x1a,
	...iov(16, 100, [...i32(4), 0x28, 2, 0]),
	...call(0, i32(1), i32(16), i32(1), i32(24)),
	0x1a,
	0x0b,
];
const named = new WebAssembly.Module(
	new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		1,
		0,
		0,
		0,
		...section(1, vec([func([I32, I32, I32, I32], [I32]), func([I32, I32], [I32]), func([], [])])),
		...section(2, vec([wasi("fd_write", 0), wasi("args_sizes_get", 1), wasi("args_get", 1)])),
		...section(3, vec([[2]])),
		...section(5, vec([[0, 1]])),
		...section(7, vec([[...name("memory"), 2, 0], [...name("_start"), 0, 3]])),
		...section(10, vec([[...uleb(argv0.length + 1), 0, ...argv0]])),
	]),
);

Deno.test("argv[0] is the module's name", () => {
	// It was one app's binary name for every module, so a second module
	// read another's name as its own.
	for (const n of ["golaberto-odds", "other"]) {
		assertEquals(new TextDecoder().decode(runWasm(named, text(""), n)), `${n}\0`);
	}
});
