import { types, type TypeField, type TypeSource, type TypeTable } from "../../client/src/types.ts";

export type TypeBoundary = { fields: readonly TypeField[]; types: TypeTable };
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
