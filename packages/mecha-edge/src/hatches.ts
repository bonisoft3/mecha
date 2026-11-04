export interface HatchQuery {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}
export interface HatchDatabase extends HatchQuery {
  transaction<T>(fn: (tx: HatchQuery) => Promise<T>): Promise<T>
}
export interface EdgeHatch {
  route: string
  create(context: { database: HatchDatabase; env: Record<string, unknown> }): {
    fetch(request: Request): Promise<Response>
    /** Called on the cluster's poke, hourly: what no request will come back for. */
    sweep?(): Promise<void>
  }
}
export function hatchAt(hatches: EdgeHatch[], pathname: string): EdgeHatch | undefined {
  return hatches.find(hatch => pathname === hatch.route || pathname.startsWith(`${hatch.route}/`))
}
