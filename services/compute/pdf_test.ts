import { assertEquals, assertRejects } from "@std/assert";
import { PDFDocument } from "@pdfme/pdf-lib";
import { Cage, compile } from "./workers.ts";

// A whole 1×1 JPEG: its start-of-frame names the size pdf-lib reads.
const JPEG = Uint8Array.from(
	atob(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
	),
	(c) => c.charCodeAt(0),
);

async function run(body: string, endowments = ["Pdf"]) {
	const cage = new Cage("print.js");
	try {
		await cage.load(
			compile(
				"print.js",
				`
      export const reads=[];
      export const queries={};
      export const plan=()=>[];
      export async function finish(inputs, outputs){${body}}
    `,
			),
			endowments,
		);
		await cage.ask({ inputs: { jpeg: [...JPEG] }, seed: 0 });
		return (await cage.ask({ outputs: [] })).out;
	} finally {
		cage.close();
	}
}

const twoFaces = `
  const jpeg=new Uint8Array(inputs.jpeg);
  const pdf=await Pdf.fromJpegs({size:{width:100,height:50},title:'Deck',pages:[
    {jpeg,x:0,y:0,width:200,height:50},{jpeg,x:-100,y:0,width:200,height:50}]});
  return [...pdf];
`;

Deno.test("Pdf requires a declaration and exposes one frozen call", async () => {
	await assertRejects(() => run("return Pdf.fromJpegs({});", []), Error, "Pdf is not endowed");
	assertEquals(
		await run("return [Object.isFrozen(Pdf),Object.keys(Pdf),typeof Pdf.load,typeof PDFDocument];"),
		[true, ["fromJpegs"], "undefined", "undefined"],
	);
});

// Regression: by default pdf-lib stamps the host's clock as the modification
// date, so two runs a second apart differed.
Deno.test("the same pages write the same bytes, a second apart", async () => {
	const first = await run(twoFaces) as number[];
	await new Promise((r) => setTimeout(r, 1100));
	const second = await run(twoFaces) as number[];
	assertEquals(new TextDecoder().decode(Uint8Array.from(first.slice(0, 5))), "%PDF-");
	assertEquals(second, first);
	const doc = await PDFDocument.load(Uint8Array.from(first), { updateMetadata: false });
	assertEquals(doc.getPageCount(), 2);
	assertEquals(doc.getPage(1).getSize(), { width: 100, height: 50 });
	assertEquals([doc.getTitle(), doc.getModificationDate(), doc.getCreationDate()], ["Deck", undefined, undefined]);
});

Deno.test("Pdf refuses what is not JPEG pages", async () => {
	await assertRejects(() => run("return Pdf.fromJpegs({size:{width:1,height:1},pages:[{jpeg:'x',x:0,y:0,width:1,height:1}]});"), Error, "page 0 carries no JPEG bytes");
	await assertRejects(() => run("return Pdf.fromJpegs({size:{width:0,height:1},pages:[]});"), Error, "size is {width, height}");
});
