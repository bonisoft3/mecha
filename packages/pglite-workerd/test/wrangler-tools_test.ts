import assert from 'node:assert/strict'

Deno.test('Wrangler resolution refuses an unspecified bootstrap mise', async () => {
  const helper = new URL('../wrangler-tools.ts', import.meta.url).href
  const result = await new Deno.Command(Deno.execPath(), {
    args: ['eval', '--no-config', `import { wranglerTools } from ${JSON.stringify(helper)}; await wranglerTools()`],
    env: { SAYT_MISE_BIN: '' }, stdin: 'null', stdout: 'piped', stderr: 'piped',
  }).output()
  assert.notEqual(result.code, 0)
  assert.match(new TextDecoder().decode(result.stderr), /SAYT_MISE_BIN is required/)
})

Deno.test('Wrangler resolution uses package pins with an unrelated cwd and conflicting tools on PATH', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'wrangler-tools-' })
  const helper = new URL('../wrangler-tools.ts', import.meta.url).href
  const nodePin = /^node = "([^"]+)"$/m.exec(await Deno.readTextFile(new URL('../../../mise.toml', import.meta.url)))![1]
  const wranglerPin = /^"npm:wrangler" = "([^"]+)"$/m.exec(await Deno.readTextFile(new URL('../mise.toml', import.meta.url)))![1]
  try {
    for (const bin of ['node', 'wrangler', 'mise']) await Deno.writeTextFile(`${directory}/${bin}`, '#!/bin/sh\nexit 73\n', { mode: 0o755 })
    // A fresh npm-backend install has a different layout from older caches.
    // Execute the real tools so a guessed path or Wrangler's shebang fails.
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['eval', '--no-config', `
        import { wranglerTools } from ${JSON.stringify(helper)}
        const { node, wrangler, env } = await wranglerTools()
        const version = async (cmd) => {
          const result = await new Deno.Command(cmd, { args: ['--version'], env, stdin: 'null', stdout: 'piped', stderr: 'inherit' }).output()
          if (!result.success) throw new Error('Tool version command exited ' + result.code)
          return new TextDecoder().decode(result.stdout).trim()
        }
        console.log(JSON.stringify({ node: await version(node), wrangler: await version(wrangler) }))
      `],
      cwd: directory, env: { PATH: `${directory}:/usr/bin:/bin` }, stdin: 'null', stdout: 'piped', stderr: 'inherit',
    }).output()
    assert.equal(result.code, 0)
    const versions = JSON.parse(new TextDecoder().decode(result.stdout))
    assert.equal(versions.node, `v${nodePin}`)
    assert.equal(versions.wrangler, wranglerPin)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
