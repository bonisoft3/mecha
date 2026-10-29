import assert from "node:assert/strict";
import { decode, encode } from "fast-png";
import { whitenBorderBackground, whiteBackgroundPng } from "./white-background.ts";

Deno.test("background cleanup preserves enclosed gray details and colored highlights", () => {
  const data = new Uint8Array(7 * 7 * 4);
  for (let p = 0; p < 49; p++) data.set([225, 224, 222, 255], p * 4);
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) data.set([30, 40, 60, 255], (y * 7 + x) * 4);
  data.set([225, 224, 222, 255], (3 * 7 + 3) * 4);
  data.set([255, 225, 205, 255], 4);
  whitenBorderBackground(data, 7, 7);
  assert.deepEqual([...data.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...data.slice(4, 8)], [255, 225, 205, 255]);
  assert.deepEqual([...data.slice(96, 100)], [225, 224, 222, 255]);
  assert.deepEqual([...data.slice(64, 68)], [30, 40, 60, 255]);
});

Deno.test("cleanup encodes true PNG white pixels and blends shadow edges gradually", () => {
  const data = new Uint8Array([225,225,225,255, 200,200,200,255, 180,180,180,255]);
  const output = whiteBackgroundPng(encode({width:3,height:1,channels:4,depth:8,data}));
  assert.deepEqual([...output.slice(0, 8)], [137,80,78,71,13,10,26,10]);
  const result = decode(output).data;
  assert.equal(result[0],255);
  assert.ok(result[4]>200 && result[4]<255);
  assert.equal(result[8],180);
});

Deno.test("unknown image formats fail explicitly", () => {
  assert.throws(() => whiteBackgroundPng(new Uint8Array([1,2,3])), /JPEG or PNG/);
});

Deno.test("already-white backgrounds retain their existing soft shadows", () => {
  const data = new Uint8Array(20 * 20 * 4).fill(255);
  data.set([205,205,205,255], (10 * 20 + 10) * 4);
  const before = data.slice();
  whitenBorderBackground(data,20,20);
  assert.deepEqual(data,before);
});
