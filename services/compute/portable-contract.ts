import { types, type TypeField, type TypeTable, type TypeSource } from "../../packages/client/src/types.ts";
// Direct source imports avoid Deno linking the browser workspace from import-map targets.
export * from "../../packages/client/src/types.ts";
export { typedSql } from "../../packages/lake/src/lake-types.ts";

export type TypeBoundary = { fields: readonly TypeField[]; types: TypeTable };
export type TypeSchemas = Record<string, readonly TypeField[]>;
type Row = Record<string, unknown>;

export function bindBoundary(boundary: TypeBoundary) {
  const bound = types(boundary.types);
  if (!Array.isArray(boundary.fields) || boundary.fields.length === 0) {
    throw new Error("a portable boundary requires fields");
  }
  const names = new Set<string>();
  for (const field of boundary.fields) {
    if (
      !field || typeof field.name !== "string" || !field.name.length ||
      names.has(field.name)
    ) throw new Error("portable fields require unique, nonempty names");
    names.add(field.name);
    if (bound.canonicalType(field.type) !== field.type) {
      throw new Error(`portable field ${field.name} requires a canonical type`);
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      throw new Error(`portable field ${field.name} requires a boolean required flag`);
    }
    if (field.type === "decimal") bound.normalizeValue(field, "0");
  }
  const columns = (actual: readonly string[]) => {
    if (
      actual.length !== names.size || actual.some((name) => !names.has(name)) || new Set(actual).size !== actual.length
    ) {
      throw new Error("portable columns differ from their declared fields");
    }
  };
  const rows = (input: readonly Row[], source: TypeSource): Row[] =>
    input.map((row) => {
      columns(Object.keys(row));
      return Object.fromEntries(boundary.fields.map((field) => {
        const value = bound.normalizeValue(field, row[field.name], source);
        if (field.required && value === null) throw new Error(`portable field ${field.name} is required`);
        return [field.name, value];
      }));
    });
  return { bound, columns, rows };
}

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
