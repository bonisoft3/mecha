import { types, type TypeField, type TypeTable } from "../../packages/client/src/types.ts";
// Direct source imports avoid Deno linking the browser workspace from import-map targets.
export * from "../../packages/client/src/types.ts";
export { typedSql } from "../../packages/lake/src/lake-types.ts";
import { bindBoundary, type TypeBoundary } from "../../packages/compute-snapshot/src/boundary.ts";
export { bindBoundary, type TypeBoundary };

export type TypeSchemas = Record<string, readonly TypeField[]>;
type Row = Record<string, unknown>;

export function validateSchemas(
  table: TypeTable | undefined,
  schemas: TypeSchemas | undefined,
  names: readonly string[],
  complete = false,
): void {
  if (schemas === undefined) return;
  if (!table) throw new Error("portable schemas require a type table");
  types(table);
  if (schemas === null || typeof schemas !== "object" || Array.isArray(schemas)) {
    throw new Error("portable schemas require a field map");
  }
  if (complete && names.some((name) => !Object.hasOwn(schemas, name))) {
    throw new Error("portable schemas omit a declared sink");
  }
  for (const [name, fields] of Object.entries(schemas)) {
    if (!names.includes(name)) throw new Error(`portable schema names an undeclared query or sink: ${name}`);
    bindBoundary({ fields, types: table });
  }
}

/** json_populate_recordset invokes PostgreSQL input functions, not PostgREST's domain casts. */
export function postgresRows(boundary: TypeBoundary, rows: readonly Row[]): Row[] {
  const held = bindBoundary(boundary);
  return held.rows(rows, "canonical").map((row) => {
    for (const field of boundary.fields) {
      const value = row[field.name];
      if (field.type === "bytes" && value !== null) {
        row[field.name] = "\\x" +
          Array.from(atob(value as string), (byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      }
    }
    return row;
  });
}
