import { computeReader } from '../src/compute-reader.ts'
import { computations, machine } from './compute-replica-source-program.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

export class Reader extends computeReader({ pgliteWasm, initdbWasm, pgliteData, icu }, computations, machine) {}
export default { fetch() { return new Response('reader') } }
