import { assertEquals, assertRejects } from "@std/assert";
import { read, utils } from "@e965/xlsx";
import { Cage, compile } from "./workers.ts";

async function run(body: string, endowments = ["Xlsx"]) {
	const cage = new Cage("export.js");
	try {
		await cage.load(
			compile(
				"export.js",
				`
      export const reads=[];
      export const queries={};
      export const plan=()=>[];
      export function finish(inputs, outputs){${body}}
    `,
			),
			endowments,
		);
		await cage.ask({ inputs: {}, seed: 0 });
		return (await cage.ask({ outputs: [] })).out;
	} finally {
		cage.close();
	}
}

const twoSheets = `
  return [...Xlsx.fromRows({sheets:[
    {name:'Despesas',rows:[['id','descrição','valor','pago','nota'],[1,'Almoço <SP> & "café" 😀',12.5,true,null],[2,'=SUM(A1:A2)',0,false,null]]},
    {name:'Resumo',rows:[]}]})];
`;

Deno.test("Xlsx requires a declaration and exposes one frozen call", async () => {
	await assertRejects(() => run("return Xlsx.fromRows({});", []), Error, "Xlsx is not endowed");
	assertEquals(
		await run("return [Object.isFrozen(Xlsx),Object.keys(Xlsx),typeof Xlsx.read,typeof XLSX];"),
		[true, ["fromRows"], "undefined", "undefined"],
	);
});

Deno.test("the same rows write the same bytes, a second apart", async () => {
	const first = await run(twoSheets) as number[];
	await new Promise((r) => setTimeout(r, 1100));
	const second = await run(twoSheets) as number[];
	assertEquals(second, first);
	const book = read(Uint8Array.from(first));
	assertEquals(book.SheetNames, ["Despesas", "Resumo"]);
	assertEquals(utils.sheet_to_json(book.Sheets.Despesas, { header: 1, defval: null }), [
		["id", "descrição", "valor", "pago", "nota"],
		[1, 'Almoço <SP> & "café" 😀', 12.5, true, null],
		[2, "=SUM(A1:A2)", 0, false, null],
	]);
	// Text that reads as a formula is stored as text.
	assertEquals([book.Sheets.Despesas.B3.t, book.Sheets.Despesas.B3.f], ["s", undefined]);
	assertEquals(utils.sheet_to_json(book.Sheets.Resumo, { header: 1 }), []);
});

Deno.test("Xlsx refuses what is not sheets of plain cells", async () => {
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[]});"), Error, "sheets is a non-empty list");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'a/b',rows:[]}]});"), Error, "sheet 0's name is 1 to 31 characters");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'History',rows:[]}]});"), Error, "and not History");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'a\\nb',rows:[]}]});"), Error, "or a control character");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'A',rows:[]},{name:'a',rows:[]}]});"), Error, 'sheet 1 repeats the name "a"');
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'A',rows:[[1],'x']}]});"), Error, "sheet 0 row 1 is a list");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'A',rows:[[1,NaN]]}]});"), Error, "sheet 0 row 0 cell 1 is not text");
	await assertRejects(() => run("return Xlsx.fromRows({sheets:[{name:'A',rows:[[new Date(0)]]}]});"), Error, "sheet 0 row 0 cell 0 is not text");
});
