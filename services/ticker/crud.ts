/** A non-2xx CRUD response is an error, never a row set. */
export type Crud = (
  method: string,
  path: string,
  opts?: { body?: unknown; prefer?: string },
) => Promise<Record<string, unknown>[]>;

/** Tick primary keys absorb redelivery at either tier. */
export const ABSORB = "return=representation,resolution=ignore-duplicates";
