import { PagedExecution, type ExecutionDatabase } from './paged-execution.ts'
import { PagedQuery } from './paged-query.ts'
import { outputFor, type SnapshotProgram } from './snapshot-program.ts'
import { pagedProgram, type PagedRequest } from './paged-transport.ts'


export async function pagedQueryAction(db: ExecutionDatabase, programs: readonly SnapshotProgram[], request: PagedRequest) {
  const program = pagedProgram(programs, request.capture)
  const queries = new PagedQuery(db, programs)
  if (request.action === 'initialize') {
    if (!request.manifest) throw new Error('missing paged manifest')
    for (const field of ['id', 'name', 'version', 'revision'] as const) {
      if (request.manifest[field] !== request.capture.identity[field]) throw new Error('paged manifest identity differs')
    }
    queries.initialize(request.manifest)
  }
  const progress = queries.progress()
  for (const field of ['id', 'name', 'version', 'revision'] as const) {
    if (progress.manifest[field] !== request.capture.identity[field]) throw new Error('compute object belongs to another capture')
  }
  const execution = new PagedExecution(db, program.spec.to)
  switch (request.action) {
    case 'initialize':
    case 'status': return { ...progress, declaredQueries: Object.keys(program.queries), sinks: program.spec.to, execution: execution.state() }
    case 'append': {
      if (!request.chunk) throw new Error('missing capture chunk')
      await queries.append(request.chunk)
      return { next: request.chunk.next }
    }
    case 'materialize': {
      if (typeof request.query !== 'string') throw new Error('missing query name')
      const result = queries.materialize(request.query)
      return { materialized: result.done ? request.query : null, done: result.done }
    }
    case 'query': {
      if (progress.queries.length !== Object.keys(program.queries).length) throw new Error('queries are not materialized')
      if (typeof request.sql !== 'string') throw new Error('missing execution query')
      return execution.query(request.sql)
    }
    case 'query-page': {
      if (progress.queries.length !== Object.keys(program.queries).length) throw new Error('queries are not materialized')
      if (typeof request.sql !== 'string' || typeof request.orderBy !== 'string' || request.revision === undefined) throw new Error('missing execution query page')
      return execution.queryPage(request.sql, request.orderBy, request.revision, request.after)
    }
    case 'commit': {
      if (progress.queries.length !== Object.keys(program.queries).length) throw new Error('queries are not materialized')
      if (!request.step || request.revision === undefined) throw new Error('missing execution step')
      const all = Object.fromEntries(program.spec.to.map(sink => [sink, []]))
      const normalized = outputFor(program, { ...all, ...request.step.writes })
      return execution.commit(request.revision, { ...request.step, writes: normalized })
    }
    case 'output': {
      if (typeof request.sink !== 'string') throw new Error('missing output sink')
      return execution.output(request.sink, request.after)
    }
    case 'outputs': return execution.manifest()
    default: throw new Error('unknown paged query action')
  }
}
