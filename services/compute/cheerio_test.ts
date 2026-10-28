import { assertEquals, assertRejects } from "@std/assert";
import { Cage, compile } from "./workers.ts";

async function run(body: string, endowments = ["Cheerio"]) {
	const cage = new Cage("parse.js");
	try {
		await cage.load(
			compile(
				"parse.js",
				`
      export const reads=[];
      export const queries={};
      export const plan=()=>[];
      export async function finish(inputs, outputs){${body}}
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

Deno.test("Cheerio requires a declaration and does not grant acquisition", async () => {
	await assertRejects(
		() => run('return Cheerio.load("<p>x</p>")("p").text();', []),
		Error,
		"Cheerio is not endowed",
	);
	assertEquals(
		await run(
			"return [Object.isFrozen(Cheerio),typeof Cheerio.fromURL,typeof Cheerio.decodeStream,typeof fetch];",
		),
		[true, "undefined", "undefined", "undefined"],
	);
});

Deno.test("Cheerio documents support the full mutable API inside compute", async () => {
	assertEquals(
		await run(`
    const $=Cheerio.load('<ul><li>One</li><li>Two</li></ul>');
    $('li').first().text('Changed');$('ul').append('<li>Three</li>');
    return $('li').map((i,node)=>$(node).text()).get();
  `),
		["Changed", "Two", "Three"],
	);
});

Deno.test("a normal finish can call an app-owned Crawlee-shaped handler", async () => {
	assertEquals(
		await run(`
    async function requestHandler({$,request,addRequests,pushData}) {
      await pushData($('a').map((i,node)=>({name:$(node).text()})).get());
      await addRequests([{url:request.origin+$('a').attr('href')}]);
    }
    const records=[],requests=[];
    await requestHandler({$:Cheerio.load('<a href="/next">Next</a>'),request:{origin:'https://source.example'},
      pushData:async rows=>{records.push(...rows)},addRequests:async rows=>{requests.push(...rows)}});
    return {records,requests};
  `),
		{
			records: [{ name: "Next" }],
			requests: [{ url: "https://source.example/next" }],
		},
	);
});

Deno.test("Cheerio document mutation cannot cross computation workers", async () => {
	await run('const $=Cheerio.load("<p>x</p>"); $.fn.poison=123; return {};');
	assertEquals(
		await run('const $=Cheerio.load("<p>x</p>"); return typeof $.fn.poison;'),
		"undefined",
	);
});

Deno.test("Cheerio does not execute scripts or expose a host constructor", async () => {
	assertEquals(
		await run(
			'Cheerio.load("<script>globalThis.executed=true</script>"); return typeof globalThis.executed;',
		),
		"undefined",
	);
	for (
		const expression of [
			'Cheerio.load.constructor("return Deno")()',
			'Cheerio.load("<p>x</p>")("p")[0].constructor.constructor("return Deno")()',
		]
	) {
		await assertRejects(
			() => run(`return ${expression};`),
			Error,
			"Function.prototype.constructor",
		);
	}
});
