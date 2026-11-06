const encoder = new TextEncoder()

// Emscripten ccall places strings on its fixed stack, including multi-megabyte prepared parameters.
export function installHeapStrings(module) {
  const call = module.ccall.bind(module)
  module.ccall = (name, returns, types = [], values = [], options) => {
    const allocated = []
    try {
      const args = [...values]
      const parameters = types.map((type, index) => {
        if (type !== 'string') return type
        if (values[index] == null || values[index] === 0) {
          args[index] = 0
          return 'number'
        }
        const bytes = encoder.encode(values[index])
        const pointer = module._malloc(bytes.byteLength + 1)
        if (!pointer) throw new Error('DuckDB string argument allocation failed')
        allocated.push(pointer)
        module.HEAPU8.set(bytes, pointer)
        module.HEAPU8[pointer + bytes.byteLength] = 0
        args[index] = pointer
        return 'number'
      })
      return call(name, returns, parameters, args, options)
    } finally {
      for (const pointer of allocated) module._free(pointer)
    }
  }
}
