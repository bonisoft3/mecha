import { fileURLToPath } from 'node:url'
import { delimiter, dirname } from 'node:path'

/** Resolve both executables through Sayt's mise and the package's exact pins.
 * npm backend layouts vary by mise version, and Wrangler's shebang otherwise
 * selects whichever Node the caller put on PATH. */
export async function wranglerTools(cwd: string | URL = new URL('.', import.meta.url)): Promise<{ node: string; wrangler: string; env: Record<string, string> }> {
  const mise = Deno.env.get('SAYT_MISE_BIN')
  if (!mise) throw new Error('SAYT_MISE_BIN is required: run through Sayt, or set it to the mise executable installed by the repository bootstrap')
  const directory = cwd instanceof URL ? fileURLToPath(cwd) : cwd
  const which = async (bin: string, tool: string) => {
    const result = await new Deno.Command(mise, { args: ['which', bin, '--tool', tool], cwd: directory, stdin: 'null', stdout: 'piped', stderr: 'inherit' }).output()
    if (!result.success) throw new Error(`${mise} which ${bin} --tool ${tool} exited ${result.code}; install the package's pinned tools through Sayt`)
    const executable = new TextDecoder().decode(result.stdout).trim()
    if (!(await Deno.stat(executable)).isFile) throw new Error(`${tool} is not an executable file: ${executable}`)
    return executable
  }
  const [node, wrangler] = await Promise.all([which('node', 'node'), which('wrangler', 'npm:wrangler')])
  return { node, wrangler, env: { PATH: `${dirname(node)}${delimiter}${Deno.env.get('PATH') ?? ''}` } }
}
