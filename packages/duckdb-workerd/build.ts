import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import thunkHex from './thunks.json' with { type: 'json' }
import { buildNative, nativeProvenance, sha256 } from './native/build.ts'

const version = '1.33.1-dev57.0'
const directory = fileURLToPath(new URL('.', import.meta.url))
const extensions = {
  json: '993b19f7929cc305b2529c548f2842e8e7a5b112d1c88f31c84798b51901ca16',
  icu: 'ecdbbb29331f72103b8eb227db5792f186b191a4f7a359db8dda9919b0a736de',
}

export function replaceChecked(source: string, from: string | RegExp, to: string, count: number): string {
  const found = typeof from === 'string' ? source.split(from).length - 1 : [...source.matchAll(from)].length
  if (found !== count) throw new Error(`DuckDB patch expected ${count} occurrences, got ${found}: ${from}`)
  return source.replaceAll(from, to)
}

export async function verifyBytes(bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<Uint8Array<ArrayBuffer>> {
  const actual = await sha256(bytes)
  if (actual !== expected) throw new Error(`DuckDB checksum mismatch: expected ${expected}, got ${actual}`)
  return bytes
}

export function patchLoader(source: string, native = false): string {
  let patched = replaceChecked(source, 'new WebAssembly.Module(new Uint8Array(n))', 'staticModule(new Uint8Array(n))', 2)
  patched = replaceChecked(patched, 'new WebAssembly.Module(binary)', 'staticModule(binary)', 2)
  patched = replaceChecked(patched, 'new WebAssembly.Module(g)', 'staticModule(g)', 2)
  patched = replaceChecked(patched, 'loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{',
    'loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{if(!extensionModules[libName])throw Error("Unexpected extension: "+libName);binary=extensionModules[libName];', 2)
  patched = replaceChecked(patched, /var t=UTF8ToString\(e\);if\(typeof XMLHttpRequest>"u"\)\{let h=Oe\(\)[\s\S]*?u=h.response\}for\(var d=WebAssembly.validate\(u\),/g,
    'var t=UTF8ToString(e),u=extensionBytes[t.split("/").pop()];if(!u)throw Error("Unbundled extension: "+t);for(var d=WebAssembly.validate(u),', 2)
  // The browser runtime's methods close over I; copying its maps leaves those closures shared.
  patched = replaceChecked(patched, 'I={_files:new Map,', 'createWorkerdRuntime=()=>{const I={_files:new Map,', 1)
  patched = replaceChecked(patched, 'Se(I,E,e,r,t,n,a,o)}};var mr=', 'Se(I,E,e,r,t,n,a,o)}};return I},I=createWorkerdRuntime();export{createWorkerdRuntime};var mr=', 1)
  patched = replaceChecked(patched, 'eval(', 'unsupportedDynamicJavaScript(', 12)
  patched = replaceChecked(patched, 'self.location.href', '"https://duckdb.invalid/runtime.js"', 2)
  if (native) patched = replaceChecked(patched, 'return(0,vr.default)(', 'return nativeModule(', 1)
  const entries = thunkHex.map((hex, i) => `${JSON.stringify([...hex.matchAll(/../g)].map(([byte]) => parseInt(byte, 16)).join(','))}:thunk${i}`)
  return `var process=undefined;
${native ? "import nativeModule from './native-glue.js';" : ''}
export {staticModule,extensionModules,extensionBytes,unsupportedDynamicJavaScript};
${thunkHex.map((_, i) => `import thunk${i} from './thunk${i}.wasm';`).join('\n')}
const staticThunks={${entries.join(',')}};
function staticModule(bytes){const mod=staticThunks[Array.from(bytes).join(',')];if(!mod)throw Error('Unknown static DuckDB callback signature');return mod;}
function unsupportedDynamicJavaScript(){throw Error('Dynamic JavaScript is unsupported by DuckDB workerd');}
import jsonModule from './json.wasm';import icuModule from './icu.wasm';
const extensionModules={json:jsonModule,icu:icuModule};
let extensionBytes;
export function setExtensions(json,icu){extensionBytes={'json.duckdb_extension.wasm':json,'icu.duckdb_extension.wasm':icu};}
` + patched
}

export function patchNativeLoader(source: string): string {
  let patched = replaceChecked(source, 'new WebAssembly.Module(new Uint8Array(bytes))', 'staticModule(new Uint8Array(bytes))', 1)
  patched = replaceChecked(patched, 'new WebAssembly.Module(binary)', 'staticModule(binary)', 1)
  patched = replaceChecked(patched, 'new WebAssembly.Module(bytes)', 'staticModule(bytes)', 1)
  patched = replaceChecked(patched, 'loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{',
    'loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{if(!extensionModules[libName])throw Error("Unexpected extension: "+libName);binary=extensionModules[libName];', 1)
  patched = replaceChecked(patched, /var url=UTF8ToString\(\$0\);if\(typeof XMLHttpRequest==="undefined"\)\{const os=require\("os"\);[\s\S]*?uInt8Array=xhr.response\}var valid=WebAssembly.validate/g,
    'var url=UTF8ToString($0),uInt8Array=extensionBytes[url.split("/").pop()];if(!uInt8Array)throw Error("Unbundled extension: "+url);var valid=WebAssembly.validate', 1)
  patched = replaceChecked(patched, 'eval(', 'unsupportedDynamicJavaScript(', 6)
  patched = replaceChecked(patched, 'self.location.href', '"https://duckdb.invalid/runtime.js"', 1)
  const commonJS = "if (typeof exports === 'object' && typeof module === 'object')\n  module.exports = DuckDB;\nelse if (typeof define === 'function' && define['amd'])\n  define([], () => DuckDB);"
  patched = replaceChecked(patched, commonJS, 'export default DuckDB;', 1)
  patched = replaceChecked(patched, /require\("(?:fs|path|crypto|ws|child_process)"\)/g, 'unsupportedNodeRuntime()', 7)
  return `var process=undefined;
import {staticModule,extensionModules,extensionBytes,unsupportedDynamicJavaScript} from './duckdb.mjs';
function unsupportedNodeRuntime(){throw Error('Node.js APIs are unavailable in DuckDB workerd');}
` + patched
}

async function command(args: string[]): Promise<string> {
  const result = await new Deno.Command(Deno.execPath(), { args, cwd: directory, stderr: 'inherit', stdout: 'piped' }).output()
  if (!result.success) throw new Error(`DuckDB packaging command failed: deno ${args.join(' ')}`)
  return new TextDecoder().decode(result.stdout)
}

/** Build-time only. The output is relocatable and contains no deployment/account configuration. */
export async function packageDuckDB(out: string): Promise<{ fingerprint: string; assetsDirectory: string }> {
  await command(['info', '--no-config', '--node-modules-dir=none', '--json', `npm:@duckdb/duckdb-wasm@${version}`])
  const cache = JSON.parse(await command(['info', '--json'])).denoDir
  const dist = path.join(cache, 'npm/registry.npmjs.org/@duckdb/duckdb-wasm', version, 'dist')
  const [loader, native, ...extensionBytes] = await Promise.all([
    Deno.readFile(path.join(dist, 'duckdb-browser-blocking.mjs')).then((bytes) => verifyBytes(bytes, '711879e43bf38648f35f6d5e0a6dfffb9c8918ed085466a891902845cdf9e710')),
    buildNative(cache),
    ...Object.entries(extensions).map(async ([name, hash]) => {
      const response = await fetch(`https://extensions.duckdb.org/v1.5.4/wasm_eh/${name}.duckdb_extension.wasm`)
      if (!response.ok) throw new Error(`DuckDB ${name} extension download failed: ${response.status}`)
      return verifyBytes(new Uint8Array(await response.arrayBuffer()), hash)
    }),
  ])
  const patched = patchLoader(new TextDecoder().decode(loader), true)
  await Deno.mkdir(path.join(out, 'assets'), { recursive: true })
  const temporary = await Deno.makeTempDir({ prefix: 'duckdb-workerd-' })
  try {
    await Deno.writeTextFile(path.join(temporary, 'duckdb.mjs'), patched)
    await Deno.writeTextFile(path.join(temporary, 'native-glue.js'), patchNativeLoader(native.loader))
    await command(['bundle', '--config', fileURLToPath(new URL('deno.json', import.meta.url)), '--frozen', '--platform', 'browser', '--format', 'esm', '--minify', '--external', '*.wasm', '--output', path.join(temporary, 'bundled.mjs'), path.join(temporary, 'duckdb.mjs')])
    const bundle = replaceChecked(await Deno.readTextFile(path.join(temporary, 'bundled.mjs')), 'new Function(', 'unsupportedArrowCodeGeneration(', 1)
    await Deno.writeTextFile(path.join(out, 'duckdb.mjs'), `function unsupportedArrowCodeGeneration(){throw Error('Arrow JavaScript code generation is unsupported by DuckDB workerd');}\n` + bundle)
  } finally { await Deno.remove(temporary, { recursive: true }) }
  await Deno.writeFile(path.join(out, 'duckdb.wasm'), native.wasm)
  await Deno.writeTextFile(path.join(out, 'native-build.json'), JSON.stringify(await nativeProvenance(), null, 2) + '\n')
  for (const [i, name] of Object.keys(extensions).entries()) {
    await Deno.writeFile(path.join(out, `${name}.wasm`), extensionBytes[i])
    await Deno.writeFile(path.join(out, 'assets', `${name}.bin`), extensionBytes[i])
  }
  for (const [i, hex] of thunkHex.entries()) {
    await Deno.writeFile(path.join(out, `thunk${i}.wasm`), new Uint8Array([...hex.matchAll(/../g)].map(([byte]) => parseInt(byte, 16))))
  }
  await Deno.copyFile(new URL('src/runtime.js', import.meta.url), path.join(out, 'runtime.js'))
  await Deno.copyFile(new URL('src/heap-strings.js', import.meta.url), path.join(out, 'heap-strings.js'))
  await Deno.copyFile(new URL('src/sqlite-filesystem.js', import.meta.url), path.join(out, 'sqlite-filesystem.js'))
  const files = ['duckdb.mjs', 'duckdb.wasm', 'native-build.json', 'runtime.js', 'heap-strings.js', 'sqlite-filesystem.js', ...Object.keys(extensions).flatMap((name) => [`${name}.wasm`, `assets/${name}.bin`]), ...thunkHex.map((_, i) => `thunk${i}.wasm`)].sort()
  const manifest = await Promise.all(files.map(async (name) => {
    const hash = await crypto.subtle.digest('SHA-256', await Deno.readFile(path.join(out, name)))
    return `${name}\0${[...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifest.join('\n')))
  return { fingerprint: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join(''), assetsDirectory: path.join(out, 'assets') }
}

if (import.meta.main) {
  if (Deno.args.length !== 1) throw new Error('Usage: deno run -A build.ts OUTPUT_DIRECTORY')
  await packageDuckDB(Deno.args[0])
}
