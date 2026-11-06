import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import { endowable, LANGUAGE } from "./language.ts";

type Compiled = {
  imports: readonly string[];
  exports: readonly string[];
  reexports: readonly string[];
  __syncModuleProgram__: string;
  __fixedExportMap__: Record<string, readonly string[]>;
  __liveExportMap__: Record<string, readonly [string, boolean]>;
  __needsImport__: boolean;
  __needsImportMeta__: boolean;
};

const DENIED = new Set(["eval", "Function", "globalThis"]);
const EXPORTS = ["finish", "plan", "queries", "reads"];

/** Emit an admitted Endo program as syntax, closing every ambient reference. */
export function staticFactory(
  compiled: Compiled,
  file: string,
  endowments: string[],
): string {
  const allowed = new Set([...LANGUAGE, ...endowable(endowments, file)]);
  const refuse = (why: string): never => {
    throw new TypeError(`static computation ${file}: ${why}`);
  };
  if (
    compiled.imports.length || compiled.reexports.length ||
    compiled.__needsImport__ || compiled.__needsImportMeta__
  ) {
    refuse("imports and import.meta are unavailable");
  }
  if (compiled.exports.filter(name => name !== "queryStages").sort().join() !== EXPORTS.join()) {
    refuse(`exports must be ${EXPORTS.join(", ")}`);
  }
  const ast = parse(`(${compiled.__syncModuleProgram__}\n)`, {
    sourceType: "module",
  });
  let names: string[] = [];
  let lexicalName = "";
  let globalsName = "";
  const live = new Set(
    Object.values(compiled.__liveExportMap__).filter(([, trap]) => trap).map((
      [name],
    ) => name),
  );
  // Babel's binding analysis handles escaped names, destructuring and nested
  // scopes; a textual denylist cannot establish lexical closure.
  const traverse = traverseModule.default;
  traverse(ast, {
    Program(
      path: {
        scope: {
          globals: Record<string, unknown>;
          generateUidIdentifier(name: string): { name: string };
        };
      },
    ) {
      lexicalName = path.scope.generateUidIdentifier("moduleLexicals").name;
      globalsName = path.scope.generateUidIdentifier("globals").name;
      names = Object.keys(path.scope.globals).filter((name) => !live.has(name))
        .sort();
      for (const name of names) {
        if (!allowed.has(name) || DENIED.has(name)) {
          refuse(`ambient name ${name} is unavailable`);
        }
      }
    },
    ThisExpression() {
      refuse("this is unavailable");
    },
    MetaProperty(path: { node: { meta: { name: string } } }) {
      if (path.node.meta.name === "import") {
        refuse("import.meta is unavailable");
      }
    },
    Import() {
      refuse("dynamic imports are unavailable");
    },
    Identifier(path: {
      node: { name: string };
      scope: { getBinding(name: string): unknown };
      isReferencedIdentifier(): boolean;
      isBindingIdentifier(): boolean;
      replaceWith(node: unknown): void;
    }) {
      const name = path.node.name;
      if (
        live.has(name) && !path.scope.getBinding(name) &&
        (path.isReferencedIdentifier() || path.isBindingIdentifier())
      ) {
        path.replaceWith({
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: lexicalName },
          property: { type: "Identifier", name },
        });
      }
    },
  });
  const statement = ast.program.body[0];
  if (
    ast.program.body.length !== 1 || statement.type !== "ExpressionStatement"
  ) return refuse("expected one module functor");
  const program =
    generatorModule.default(statement.expression, { comments: false }).code;
  const emitted = `({create: (${globalsName}, ${lexicalName}) => {const {${
    names.join(",")
  }} = ${globalsName}; return (${program});}, fixed: ${
    JSON.stringify(compiled.__fixedExportMap__)
  }, live: ${JSON.stringify(compiled.__liveExportMap__)}})`;
  traverse(parse(emitted, { sourceType: "module" }), {
    Program(path: { scope: { globals: Record<string, unknown> } }) {
      const remaining = Object.keys(path.scope.globals);
      if (remaining.length) {
        refuse(`unclosed emitted names: ${remaining.join(", ")}`);
      }
    },
  });
  return emitted;
}

if (import.meta.main) {
  const requests: { compiled: Compiled; file: string; endowments: string[] }[] =
    await new Response(Deno.stdin.readable).json();
  if (!Array.isArray(requests)) {
    throw new TypeError("static compilation requires a list of modules");
  }
  console.log(
    JSON.stringify(
      requests.map(({ compiled, file, endowments }) =>
        staticFactory(compiled, file, endowments)
      ),
    ),
  );
}
