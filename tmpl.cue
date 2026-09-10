@extern(embed)
package tmpl

import "strings"

// Export embedded JSON Schemas for downstream consumers.
Hello: _ @embed(file="gen/jsonschema/mecha.v1.Hello.jsonschema.json")
GroupHello: _ @embed(file="gen/jsonschema/mecha.v1.GroupHello.jsonschema.json")
CardSet: _ @embed(file="gen/jsonschema/mecha.v1.CardSet.jsonschema.json")
Flashcard: _ @embed(file="gen/jsonschema/mecha.v1.Flashcard.jsonschema.json")
GenerationRequest: _ @embed(file="gen/jsonschema/mecha.v1.GenerationRequest.jsonschema.json")

_entityBase: [
	{name: "Hello", schema: Hello},
	{name: "GroupHello", schema: GroupHello},
	{name: "CardSet", schema: CardSet},
	{name: "Flashcard", schema: Flashcard},
	{name: "GenerationRequest", schema: GenerationRequest},
]

Entities: [
	for entity in _entityBase {
		name: entity.name
		schema: entity.schema
		lower: strings.ToLower(entity.name)
		idPattern: entity.schema.properties.id.pattern | *"^[0-9a-fA-F%-]+$"
	}
]
