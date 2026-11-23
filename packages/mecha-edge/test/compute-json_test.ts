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

Deno.test('lossless JSON keeps only plain data whose numbers round-trip', () => {
  assert.equal(losslessJson({ a: [1, 2.5, 'x', null, false], b: { c: Number.MAX_SAFE_INTEGER } }), '{"a":[1,2.5,"x",null,false],"b":{"c":9007199254740991}}')
  for (const bad of [{ n: 2 ** 53 }, { n: NaN }, { d: new Date(0) }, { m: new Map() }, { u: undefined }]) {
    assert.throws(() => losslessJson(bad), /finite lossless JSON/)
  }
  assert.throws(() => losslessJson({ rows: [{ id: 9007199254740993 }] }), /value\.rows\[0\]\.id is not finite lossless JSON/)
  assert.deepEqual(parseLossless('{"a":[1,2.5]}'), { a: [1, 2.5] })
  for (const bad of ['9007199254740993', '{"n":1e999}']) assert.throws(() => parseLossless(bad), /finite lossless JSON/)
})
