import { PDFDocument } from "@pdfme/pdf-lib";

// One call, frozen by the cage that grants it: JPEG pages in, PDF bytes out.
// Nothing else of the library is reached, so no load, font, form or encryption
// path: those draw on Math.random and the clock. The document is made with no
// metadata update, since its modification date would be the host's clock, and
// saved without pausing between objects, since that pause is a timer.

type Page = { jpeg: Uint8Array; x: number; y: number; width: number; height: number };
type Spec = { size: { width: number; height: number }; title?: string; pages: Page[] };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

/** A page per entry, `size` in points, each JPEG drawn at its rectangle and
 * clipped by the page, so one image can give several pages, a face each.
 * The same bytes are embedded once. */
async function fromJpegs(spec: Spec): Promise<Uint8Array> {
  const { size, title, pages } = spec ?? ({} as Spec);
  if (!positive(size?.width) || !positive(size?.height)) throw new TypeError("Pdf.fromJpegs: size is {width, height} in points");
  if (title !== undefined && typeof title !== "string") throw new TypeError("Pdf.fromJpegs: title is a string");
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError("Pdf.fromJpegs: pages is a non-empty list");
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (title !== undefined) doc.setTitle(title);
  const embedded = new Map<Uint8Array, Awaited<ReturnType<typeof doc.embedJpg>>>();
  for (const [i, page] of pages.entries()) {
    const { jpeg, x, y, width, height } = page ?? ({} as Page);
    if (!(jpeg instanceof Uint8Array)) throw new TypeError(`Pdf.fromJpegs: page ${i} carries no JPEG bytes`);
    if (!finite(x) || !finite(y) || !positive(width) || !positive(height)) throw new TypeError(`Pdf.fromJpegs: page ${i} is {jpeg, x, y, width, height} in points`);
    let image = embedded.get(jpeg);
    if (image === undefined) embedded.set(jpeg, image = await doc.embedJpg(jpeg));
    doc.addPage([size.width, size.height]).drawImage(image, { x, y, width, height });
  }
  return await doc.save({ objectsPerTick: Infinity });
}

export const Pdf = { fromJpegs: (spec: Spec) => fromJpegs(spec) };
