import * as path from 'node:path'
import { statfsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.json' with { type: 'json' }

const here = new URL('.', import.meta.url)
const parallelism = 4
const headroom = 15 * 1024 ** 3

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
}

async function checked(bytes: Uint8Array<ArrayBuffer>, expected: string) {
  const actual = await sha256(bytes)
  if (actual !== expected) throw new Error(`Native DuckDB checksum mismatch: expected ${expected}, got ${actual}`)
  return bytes
}

async function exists(name: string): Promise<boolean> {
  try { await Deno.stat(name); return true }
  catch (error) { if (error instanceof Deno.errors.NotFound) return false; throw error }
}

function diskGuard(root: string) {
  const stats = statfsSync(root)
  if (stats.bavail * stats.bsize < headroom) throw new Error('Native DuckDB build requires 15 GiB of free disk headroom')
}

async function run(args: string[], cwd: string, env: Record<string, string>, log: string) {
  diskGuard(cwd)
  const child = new Deno.Command(args[0], { args: args.slice(1), cwd, env, stdout: 'piped', stderr: 'piped' }).spawn()
  const output = await Deno.open(log, { create: true, write: true, append: true })
  let guardFailure: Error | undefined
  const timer = setInterval(() => {
    try { diskGuard(cwd) }
    catch (error) {
      guardFailure = error as Error
      child.kill('SIGTERM')
    }
  }, 5000)
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      let offset = 0
      while (offset < chunk.length) offset += output.writeSync(chunk.subarray(offset))
    }
  }
  try {
    const [status] = await Promise.all([child.status, collect(child.stdout), collect(child.stderr)])
    if (guardFailure) throw guardFailure
    if (!status.success) {
      const tail = (await Deno.readTextFile(log)).split('\n').slice(-30).join('\n')
      throw new Error(`Native DuckDB command failed (${status.code}): ${args[0]}\n${tail}`)
    }
  } finally { clearInterval(timer); output.close() }
}

async function download(url: string, target: string, expected: string) {
  if (await exists(target)) { await checked(await Deno.readFile(target), expected); return }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Native DuckDB download failed: ${response.status} ${url}`)
  const bytes = await checked(new Uint8Array(await response.arrayBuffer()), expected)
  await Deno.writeFile(target + '.partial', bytes)
  await Deno.rename(target + '.partial', target)
}

async function extract(archive: string, directory: string, env: Record<string, string>, log: string) {
  if (await exists(path.join(directory, '.extracted'))) return
  if (await exists(directory)) await Deno.remove(directory, { recursive: true })
  await Deno.mkdir(directory, { recursive: true })
  await run(['tar', '-xf', archive, '--strip-components=1', '-C', directory], directory, env, log)
  await Deno.writeTextFile(path.join(directory, '.extracted'), '')
}

export async function nativeProvenance() {
  return { ...manifest,
    filesystemPatchSha256: await sha256(await Deno.readFile(new URL('filesystem.patch', here))),
    settingsPatchSha256: await sha256(await Deno.readFile(new URL('settings.patch', here))),
    arrowPatchSha256: await sha256(await Deno.readFile(new URL('arrow.patch', here))),
    buildScriptSha256: await sha256(await Deno.readFile(new URL('build.ts', here))),
  }
}

async function readArtifact(root: string) {
  return {
    wasm: await checked(await Deno.readFile(path.join(root, 'duckdb.wasm')), manifest.wasmSha256),
    loader: new TextDecoder('utf-8', { fatal: true }).decode(await checked(await Deno.readFile(path.join(root, 'native-glue.js')), manifest.loaderSha256)),
  }
}

async function dockerBuild(root: string, log: string) {
  const volume = 'duckdb-workerd-native-v1'
  const env = { LC_ALL: 'C', LANG: 'C' }
  const archive = path.join(root, 'deno.zip')
  await download(`https://github.com/denoland/deno/releases/download/v${manifest.denoVersion}/deno-x86_64-unknown-linux-gnu.zip`, archive, manifest.denoSha256)
  await run(['docker', 'volume', 'create', '--label', 'owner=duckdb-workerd-native', volume], root, env, log)
  const mounts = ['--rm', '--init', '--platform', manifest.dockerPlatform,
    '--mount', `type=volume,source=${volume},target=/cache`,
    '--mount', `type=bind,source=${fileURLToPath(here)},target=/native,readonly`,
    '--mount', `type=bind,source=${root},target=/output`]
  const destination = `/cache/tools/deno-${manifest.denoVersion}`
  const bootstrap = `import os,zipfile;os.makedirs('${destination}',exist_ok=True);zipfile.ZipFile('/output/deno.zip').extractall('${destination}');os.chmod('${destination}/deno',0o755)`
  await run(['docker', 'run', ...mounts, '--entrypoint', 'python3', manifest.sdkImage, '-c', bootstrap], root, env, log)
  await run(['docker', 'run', ...mounts, '--env', `DUCKDB_NATIVE_CONTAINER=${manifest.sdkImage}`,
    '--entrypoint', destination + '/deno', manifest.sdkImage,
    'run', '--no-config', '-A', '/native/build.ts', '/cache', '/output/duckdb.wasm'], root, env, log)
}

export async function buildNative(cache: string): Promise<{ wasm: Uint8Array<ArrayBuffer>; loader: string }> {
  const inputs: Record<string, unknown> = await nativeProvenance()
  delete inputs.wasmSha256
  delete inputs.loaderSha256
  const key = await sha256(new TextEncoder().encode(JSON.stringify(inputs)))
  const root = path.join(cache, 'duckdb-workerd-native', key)
  await Deno.mkdir(root, { recursive: true })
  const artifact = path.join(root, 'duckdb.wasm')
  const loaderArtifact = path.join(root, 'native-glue.js')
  const lock = await Deno.open(path.join(root, 'build.lock'), { create: true, write: true })
  await lock.lock(true)
  try {
    if (await exists(artifact) && await exists(loaderArtifact)) return await readArtifact(root)
    if (Deno.env.get('DUCKDB_NATIVE_CONTAINER') !== manifest.sdkImage) {
      await dockerBuild(root, path.join(root, 'build.log'))
      await Deno.rename(artifact + '.js', loaderArtifact)
      return await readArtifact(root)
    }
    if (Deno.build.os !== 'linux' || Deno.build.arch !== 'x86_64') throw new Error('Native DuckDB requires its pinned linux/amd64 container')
    console.log(`Building pinned DuckDB native filesystem; log: ${path.join(root, 'build.log')}`)
    const log = path.join(root, 'build.log')
    const env: Record<string, string> = { LC_ALL: 'C', LANG: 'C', CMAKE_BUILD_PARALLEL_LEVEL: String(parallelism), CCACHE_DISABLE: '1', SOURCE_DATE_EPOCH: manifest.sourceDateEpoch }
    for (const source of manifest.sources) {
      const archive = path.join(root, source.name + '.tar.gz')
      await download(`https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`, archive, source.sha256)
      await extract(archive, path.join(root, path.basename(source.repository) + '-' + source.commit), env, log)
    }
    const wasm = path.join(root, 'duckdb-wasm-' + manifest.sources[0].commit)
    for (const source of manifest.sources.slice(1)) {
      const link = path.join(wasm, 'submodules', source.name)
      const target = path.join(root, path.basename(source.repository) + '-' + source.commit)
      if (!await exists(path.join(link, 'CMakeLists.txt')) && !await exists(path.join(link, 'cpp', 'CMakeLists.txt'))) {
        if (await exists(link)) await Deno.remove(link, { recursive: true })
        await Deno.symlink(target, link, { type: 'dir' })
      }
    }
    const sdk = '/emsdk'
    env.EMSDK = sdk
    env.EM_CONFIG = path.join(sdk, '.emscripten')
    env.EMSDK_PYTHON = '/usr/bin/python3'
    env.EM_CACHE = path.join(sdk, 'upstream', 'emscripten', 'cache')
    const cmakeArchive = path.join(root, 'cmake.tar.gz')
    const cmakeRoot = path.join(root, `cmake-${manifest.cmakeVersion}-${manifest.cmake.archive}`)
    await download(`https://github.com/Kitware/CMake/releases/download/v${manifest.cmakeVersion}/cmake-${manifest.cmakeVersion}-${manifest.cmake.archive}.tar.gz`, cmakeArchive, manifest.cmake.sha256)
    await extract(cmakeArchive, cmakeRoot, env, log)
    const cmakeBin = path.join(cmakeRoot, 'bin')
    const ninjaArchive = path.join(root, 'ninja.zip')
    const ninja = path.join(root, 'ninja')
    await download(`https://github.com/ninja-build/ninja/releases/download/v${manifest.ninjaVersion}/${manifest.ninja.archive}`, ninjaArchive, manifest.ninja.sha256)
    await Deno.mkdir(ninja, { recursive: true })
    await run(['unzip', '-o', ninjaArchive, '-d', ninja], root, env, log)
    env.PATH = [cmakeBin, ninja, path.join(sdk, 'upstream', 'emscripten'), Deno.env.get('PATH')].join(path.delimiter)
    env.DUCKDB_WASM_LOADABLE_EXTENSIONS = '1'
    env.USE_GENERATED_EXPORTED_LIST = 'no'
    const patched = path.join(wasm, '.patched')
    if (!await exists(patched)) {
      for (const [component, patch] of [
        ['duckdb', 'all_of_them.patch'], ['arrow', 'fix_shared_ptr_indirection.patch'],
        ['arrow', 'hashing_compile_in_emscripten.patch'], ['rapidjson', 'cmake_minimum_required.patch'],
      ]) await run(['patch', '-p1', '--batch', '-i', path.join(wasm, 'patches', component, patch)], path.join(wasm, 'submodules', component), env, log)
      for (const name of ['filesystem.patch', 'settings.patch']) await run(['patch', '-p1', '--batch', '-i', new URL(name, here).pathname], wasm, env, log)
      await run(['patch', '-p1', '--batch', '-i', new URL('arrow.patch', here).pathname], path.join(wasm, 'submodules', 'arrow'), env, log)
      await Deno.writeTextFile(patched, key)
    }
    const canonical = await Deno.realPath(root)
    const flags = [...new Set([root, canonical])].flatMap(prefix => [`-ffile-prefix-map=${prefix}=/duckdb-native`, `-fdebug-prefix-map=${prefix}=/duckdb-native`]).join(' ')
    const build = path.join(wasm, 'build', 'patched', 'eh')
    const cmake = path.join(cmakeBin, 'cmake')
    await run([path.join(sdk, 'upstream', 'emscripten', 'emcmake'), cmake, '-S', path.join(wasm, 'lib'), '-B', build,
      '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DWASM_MIN_SIZE=1', '-DWITH_WASM_EXCEPTIONS=1',
      '-DDUCKDB_CUSTOM_PLATFORM=wasm_eh', '-DDUCKDB_EXPLICIT_PLATFORM=wasm_eh', `-DDUCKDB_WASM_VERSION=${manifest.wasmVersion}`,
      `-DCMAKE_CXX_FLAGS=${flags}`, `-DCMAKE_MAKE_PROGRAM=${path.join(ninja, 'ninja')}`], wasm, env, log)
    await run([cmake, '--build', build, '--target', 'duckdb_wasm', '--parallel', '1'], wasm, env, log)
    const bytes = await Deno.readFile(path.join(build, 'duckdb_wasm.wasm'))
    for (const prefix of new Set([root, canonical])) {
      if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(prefix)) throw new Error('Native DuckDB artifact embeds its build directory')
    }
    const loader = await Deno.readFile(path.join(build, 'duckdb_wasm.js'))
    const wasmHash = await sha256(bytes), loaderHash = await sha256(loader)
    if (wasmHash !== manifest.wasmSha256 || loaderHash !== manifest.loaderSha256) {
      throw new Error(`Native artifact hashes differ: wasm=${wasmHash} loader=${loaderHash}`)
    }
    await Deno.writeFile(loaderArtifact + '.partial', loader)
    await Deno.rename(loaderArtifact + '.partial', loaderArtifact)
    await Deno.writeFile(artifact + '.partial', bytes)
    await Deno.rename(artifact + '.partial', artifact)
    return { wasm: bytes, loader: new TextDecoder('utf-8', { fatal: true }).decode(loader) }
  } finally { await lock.unlock(); lock.close() }
}

if (import.meta.main) {
  if (Deno.args.length !== 2) throw new Error('Usage: deno run -A native/build.ts CACHE_DIRECTORY OUTPUT_WASM')
  const built = await buildNative(Deno.args[0])
  await Deno.writeFile(Deno.args[1], built.wasm)
  await Deno.writeTextFile(Deno.args[1] + '.js', built.loader)
}
