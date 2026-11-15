import assert from 'node:assert/strict'
import * as path from 'node:path'
import { replaceChecked, verifyBytes } from '../build.ts'
import { nativeProvenance, readArtifact, sha256 } from '../native/build.ts'

Deno.test('loader patch guards reject missing and duplicate upstream structures', () => {
  assert.equal(replaceChecked('aa bb aa', 'aa', 'cc', 2), 'cc bb cc')
  assert.throws(() => replaceChecked('aa', 'aa', 'cc', 2), /expected 2 occurrences, got 1/)
  assert.throws(() => replaceChecked('aa aa aa', /aa/g, 'cc', 2), /expected 2 occurrences, got 3/)
})

Deno.test('upstream assets must match their pinned bytes', async () => {
  const bytes = new TextEncoder().encode('abc')
  assert.equal(await verifyBytes(bytes, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), bytes)
  await assert.rejects(() => verifyBytes(bytes, '0'.repeat(64)), /checksum mismatch/)
})

// Different x86_64/Rosetta host CPUs fold floating-point constants into distinct valid WASM binaries;
// cache integrity verifies the recorded sidecar SHA-256, WebAssembly validity, and pinned JS glue hash.
Deno.test('cached native artifact verifies recorded WASM hash, module validity, and pinned loader hash', async () => {
  const provenance = await nativeProvenance() as Record<string, unknown>
  assert.equal('wasmSha256' in provenance, false)
  assert.equal('rosettaWasmSha256' in provenance, false)
  const root = await Deno.makeTempDir({ prefix: 'duckdb-native-cache-test-' })
  try {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    const loader = new TextEncoder().encode('export default function DuckDB() {}\n')
    const wasmHash = await sha256(wasm)
    const loaderHash = await sha256(loader)
    await Deno.writeFile(path.join(root, 'duckdb.wasm'), wasm)
    await Deno.writeTextFile(path.join(root, 'duckdb.wasm.sha256'), `${wasmHash}\n`)
    await Deno.writeFile(path.join(root, 'native-glue.js'), loader)
    const loaded = await readArtifact(root, loaderHash)
    assert.equal(loaded.wasmSha256, wasmHash)
    assert.deepEqual(loaded.wasm, wasm)
    assert.equal(loaded.loader, 'export default function DuckDB() {}\n')

    await assert.rejects(() => readArtifact(root, '0'.repeat(64)), /checksum mismatch/)

    const invalidWasm = new TextEncoder().encode('not-wasm')
    await Deno.writeFile(path.join(root, 'duckdb.wasm'), invalidWasm)
    await assert.rejects(() => readArtifact(root, loaderHash), /checksum mismatch/)
    await Deno.writeTextFile(path.join(root, 'duckdb.wasm.sha256'), `${await sha256(invalidWasm)}\n`)
    await assert.rejects(() => readArtifact(root, loaderHash), /not a valid WebAssembly module/)

    await Deno.writeTextFile(path.join(root, 'duckdb.wasm.sha256'), 'malformed\n')
    await assert.rejects(() => readArtifact(root, loaderHash), /Invalid cached DuckDB checksum/)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
