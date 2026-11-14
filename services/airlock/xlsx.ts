import { utils, write } from "@e965/xlsx";

// One call, frozen by the cage that grants it: rows in, XLSX bytes out.
// Nothing else of SheetJS is reached, so no reader, formula, date or document
// property path: a workbook written from plain cells reads no clock and draws
// nothing, and the same rows give the same bytes. The library is plain
// ECMAScript, which QuickJS runs as it stands.

type Cell = string | number | boolean | null;
type Sheet = { name: string; rows: Cell[][] };
type Spec = { sheets: Sheet[] };

// Excel's own limits: a sheet's name, a cell's text and a sheet's extent.
// "History" is the one name Excel keeps for itself.
const NAME = /^(?!')(?!history$)[^\\/?*[\]:\x00-\x1f\x7f]{1,31}(?<!')$/i;
const TEXT = 32767;
const ROWS = 1048576;
const COLUMNS = 16384;

const cell = (v: unknown): v is Cell =>
  v === null || typeof v === "boolean" || (typeof v === "string" && v.length <= TEXT) || (typeof v === "number" && Number.isFinite(v));

/** A sheet per entry, in order, each row a list of cells from column A: text,
 * a finite number, a boolean, or null for an empty cell. Text is written as
 * text, never as a formula; a date is the text or the number its caller makes
 * of it. */
function fromRows(spec: Spec): Uint8Array {
  const { sheets } = spec ?? ({} as Spec);
  if (!Array.isArray(sheets) || sheets.length === 0) throw new TypeError("Xlsx.fromRows: sheets is a non-empty list");
  const book = utils.book_new();
  const names = new Set<string>();
  for (const [i, sheet] of sheets.entries()) {
    const { name, rows } = sheet ?? ({} as Sheet);
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new TypeError(`Xlsx.fromRows: sheet ${i}'s name is 1 to 31 characters, none of \\ / ? * [ ] : or a control character, no leading or trailing apostrophe, and not History`);
    }
    if (names.has(name.toLowerCase())) throw new TypeError(`Xlsx.fromRows: sheet ${i} repeats the name ${JSON.stringify(name)}`);
    names.add(name.toLowerCase());
    if (!Array.isArray(rows) || rows.length > ROWS) throw new TypeError(`Xlsx.fromRows: sheet ${i}'s rows is a list of at most ${ROWS} rows`);
    for (const [r, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length > COLUMNS) throw new TypeError(`Xlsx.fromRows: sheet ${i} row ${r} is a list of at most ${COLUMNS} cells`);
      const c = row.findIndex((v) => !cell(v));
      if (c !== -1) throw new TypeError(`Xlsx.fromRows: sheet ${i} row ${r} cell ${c} is not text of at most ${TEXT} characters, a finite number, a boolean or null`);
    }
    utils.book_append_sheet(book, utils.aoa_to_sheet(rows), name);
  }
  return new Uint8Array(write(book, { type: "array", bookType: "xlsx", compression: true }));
}

export const Xlsx = { fromRows: (spec: Spec) => fromRows(spec) };
