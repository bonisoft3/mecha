import assert from 'node:assert/strict'
import { losslessJson, parseLossless, strictJson } from '../../compute-snapshot/src/json.ts'

// The server, the edge and the browser each kept their own copy of these rules,
// and the copies disagreed: the server's let a property whose toJSON answered
// undefined vanish, while the others refused it. One module now decides.
Deno.test('strict JSON refuses what JSON cannot hold, before and after toJSON', () => {
  assert.equal(strictJson({ at: new Date(0), n: 1.5, s: 'x', l: [null, true] }), '{"at":"1970-01-01T00:00:00.000Z","n":1.5,"s":"x","l":[null,true]}')
  assert.equal(strictJson({ b: 1, a: { d: 2, c: 3 } }, true), '{"a":{"c":3,"d":2},"b":1}')
  for (const bad of [{ n: NaN }, { n: Infinity }, { u: undefined }, { b: 1n }, { f: () => 1 }, { s: Symbol('s') }, [undefined], { gone: { toJSON: () => undefined } }]) {
    assert.throws(() => strictJson(bad), TypeError, JSON.stringify(Object.keys(bad)))
  }
  assert.throws(() => strictJson(undefined), /no JSON value/)
})

// A double past 2^53 is still a value a sink keeps (1e30 is a native DOUBLE),
// and JSON prints it as its shortest round-tripping decimal, not its exact
// integer (1000000000000000100 is ...128). Reading refuses only a literal its
// double prints back differently, an int64 that lost precision.
Deno.test('lossless JSON keeps finite plain data and refuses integer literals no double holds', () => {
  assert.equal(losslessJson({ a: [1, 2.5, 'x', null, false], b: { c: 2 ** 53, d: 1e30 } }), '{"a":[1,2.5,"x",null,false],"b":{"c":9007199254740992,"d":1e+30}}')
  for (const bad of [{ n: NaN }, { n: Infinity }, { d: new Date(0) }, { m: new Map() }, { u: undefined }]) {
    assert.throws(() => losslessJson(bad), /finite lossless JSON/)
  }
  assert.throws(() => losslessJson({ rows: [{ id: NaN }] }), /value\.rows\[0\]\.id is not finite lossless JSON/)
  assert.deepEqual(parseLossless('{"a":[1,2.5,1e30,9007199254740992]}'), { a: [1, 2.5, 1e30, 2 ** 53] })
  for (const n of [1000000000000000100, -1e20, 2 ** 70]) assert.equal(parseLossless(losslessJson(n)), n)
  assert.equal(parseLossless('1180591620717411303424'), 2 ** 70)
  for (const bad of ['9007199254740993', '{"n":-9007199254740995}', '{"n":1e999}']) assert.throws(() => parseLossless(bad), /finite lossless JSON/)
})
