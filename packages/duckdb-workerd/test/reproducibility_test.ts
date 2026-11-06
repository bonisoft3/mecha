import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

Deno.test('runtime bytes and fingerprint are independent of the caller working directory', async () => {
  const directory = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await Deno.makeTempDir({ prefix: 'duckdb-workerd-reproducibility-' })
  const build = new URL('../build.ts', import.meta.url).href
  const results = []
  try {
    for (const [index, cwd] of [directory, path.resolve(directory, '../../../..')].entries()) {
      const out = path.join(temporary, String(index))
      const script = `import {packageDuckDB} from ${JSON.stringify(build)}; console.log(JSON.stringify(await packageDuckDB(${JSON.stringify(out)})));`
      const result = await new Deno.Command(Deno.execPath(), {
        args: ['eval', '--no-config', '--no-lock', script], cwd, stderr: 'inherit', stdout: 'piped',
      }).output()
      assert.equal(result.success, true)
      const packaged = JSON.parse(new TextDecoder().decode(result.stdout))
      results.push({ fingerprint: packaged.fingerprint, loader: await Deno.readTextFile(path.join(out, 'duckdb.mjs')) })
    }
    assert.equal(results[0].fingerprint, results[1].fingerprint)
    assert.equal(results[0].loader, results[1].loader)
  } finally { await Deno.remove(temporary, { recursive: true }) }
})
