@extern(embed)
package tmpl

// The entities' JSON Schemas as buf emits them; tmpl_tool.cue renders them
// into services/database/schemas/schema.hcl.
Hello: _ @embed(file="gen/jsonschema/mecha.v1.Hello.jsonschema.json")
GroupHello: _ @embed(file="gen/jsonschema/mecha.v1.GroupHello.jsonschema.json")

Entities: [
	{name: "Hello", schema: Hello},
	{name: "GroupHello", schema: GroupHello},
]
