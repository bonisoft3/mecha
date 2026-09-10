declare const Go: any

export interface BloblangCreateOptions {
  wasmBinary: ArrayBuffer | Buffer
  wasmExecJs: string
}

export class BloblangRuntime {
  private constructor() {}

  /**
   * Create a BloblangRuntime from in-memory WASM binary.
   *
   * SECURITY: `wasmExecJs` is evaluated via `new Function()` (equivalent to eval).
   * Only pass trusted content (Go's wasm_exec.js). The consuming app's CSP must
   * allow 'unsafe-eval' for this module to work.
   */
  static async create(options: BloblangCreateOptions): Promise<BloblangRuntime> {
    // Ensure process.cwd exists — Go WASM's syscall/js needs it, but bundlers
    // like Vite provide their own `process` object that omits cwd().
    const proc = (globalThis as any).process
    if (proc && typeof proc.cwd !== 'function') {
      proc.cwd = () => '/'
    }

    const fn = new Function(options.wasmExecJs)
    fn()

    const go = new Go()
    const result = await WebAssembly.instantiate(options.wasmBinary as BufferSource, go.importObject)
    go.run((result as unknown as WebAssembly.WebAssemblyInstantiatedSource).instance)

    return new BloblangRuntime()
  }

  /**
   * Create a BloblangRuntime by fetching WASM from URLs.
   *
   * SECURITY: Both URLs must serve trusted content. The wasm_exec.js is
   * evaluated via `new Function()`. Consider using Subresource Integrity
   * if loading from a CDN.
   */
  static async fromUrls(wasmUrl: string, wasmExecUrl: string): Promise<BloblangRuntime> {
    const [wasmExecResponse, wasmResponse] = await Promise.all([
      fetch(wasmExecUrl),
      fetch(wasmUrl),
    ])
    return BloblangRuntime.create({
      wasmBinary: await wasmResponse.arrayBuffer(),
      wasmExecJs: await wasmExecResponse.text(),
    })
  }

  async execute(mapping: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resultStr = (globalThis as any).blobl(mapping, JSON.stringify(input))

    if (typeof resultStr === 'string' && resultStr.startsWith('ERROR:')) {
      throw new Error(resultStr.slice(7))
    }

    return JSON.parse(resultStr)
  }

  destroy(): void {}
}
