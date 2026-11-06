import assert from 'node:assert/strict'
import { installHeapStrings } from '../src/heap-strings.js'

Deno.test('ccall strings use UTF-8 heap allocations and release them after success and failure', () => {
  const allocated: number[] = []
  const freed: number[] = []
  const types = ['number', 'string', 'string', 'string']
  const values = [7, 'ação', '', null]
  let fail = false
  const module = {
    HEAPU8: new Uint8Array(1024),
    _malloc(size: number) { assert.ok(size > 0); const pointer = 16 + allocated.length * 32; allocated.push(pointer); return pointer },
    _free(pointer: number) { freed.push(pointer) },
    ccall(name: string, returns: string, actualTypes: string[], args: number[], options: unknown) {
      assert.equal(name, 'operation')
      assert.equal(returns, 'number')
      assert.deepEqual(actualTypes, ['number', 'number', 'number', 'number'])
      assert.equal(args[0], 7)
      assert.deepEqual(module.HEAPU8.slice(args[1], args[1] + 7), new Uint8Array([97, 195, 167, 195, 163, 111, 0]))
      assert.equal(module.HEAPU8[args[2]], 0)
      assert.equal(args[3], 0)
      assert.deepEqual(options, { example: true })
      if (fail) throw new Error('operation failed')
      return 42
    },
  }
  installHeapStrings(module)
  const call = () => module.ccall('operation', 'number', types, values as unknown as number[], { example: true })
  assert.equal(call(), 42)
  assert.deepEqual(freed, allocated)
  fail = true
  assert.throws(call, /operation failed/)
  assert.deepEqual(freed, allocated)
  assert.deepEqual(types, ['number', 'string', 'string', 'string'])
  assert.deepEqual(values, [7, 'ação', '', null])
})

Deno.test('ccall allocation failure releases earlier arguments before rejecting', () => {
  const freed: number[] = []
  let allocations = 0
  const module = {
    HEAPU8: new Uint8Array(32),
    _malloc: () => ++allocations === 1 ? 8 : 0,
    _free(pointer: number) { freed.push(pointer) },
    ccall: (..._args: unknown[]) => { throw new Error('must not execute') },
  }
  installHeapStrings(module)
  assert.throws(() => module.ccall('operation', null, ['string', 'string'], ['one', 'two']), /allocation failed/)
  assert.deepEqual(freed, [8])
})
