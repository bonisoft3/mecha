// vim: set filetype=hcl:
// Generated Atlas HCL from JSON Schema

schema "public" {
  comment = "Standard PostgreSQL public schema"
}
table "Hello" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
    default = sql("uuidv7()")
  }
  column "createdAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "updatedAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "message" {
    type = varchar(500)
    null = false
  }

  // Enrichment columns for rpk bloblang pipeline output
  column "processed_at" {
    type = timestamptz
    null = true
  }
  column "source" {
    type = varchar(100)
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}

table "GroupHello" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
    default = sql("uuidv7()")
  }
  column "createdAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "updatedAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "messages" {
    type = varchar(2000)
    null = false
  }

  // Enrichment columns for rpk bloblang pipeline output
  column "processed_at" {
    type = timestamptz
    null = true
  }
  column "source" {
    type = varchar(100)
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}

table "CardSet" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
    default = sql("uuidv7()")
  }
  column "createdAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "updatedAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "category" {
    type = varchar(255)
    null = false
  }
  column "description" {
    type = varchar(255)
    null = false
  }
  column "name" {
    type = varchar(255)
    null = false
  }
  column "tags" {
    type = jsonb
    null = false
  }
  column "userId" {
    type = varchar(255)
    null = false
  }

  // Enrichment columns for rpk bloblang pipeline output
  column "processed_at" {
    type = timestamptz
    null = true
  }
  column "source" {
    type = varchar(100)
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}

table "Flashcard" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
    default = sql("uuidv7()")
  }
  column "createdAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "updatedAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "backText" {
    type = varchar(255)
    null = false
  }
  column "cardSetId" {
    type = varchar(255)
    null = false
  }
  column "difficulty" {
    type = varchar(255)
    null = false
  }
  column "frontText" {
    type = varchar(255)
    null = false
  }
  column "hint" {
    type = varchar(255)
    null = false
  }
  column "imageUrl" {
    type = varchar(255)
    null = false
  }

  // Enrichment columns for rpk bloblang pipeline output
  column "processed_at" {
    type = timestamptz
    null = true
  }
  column "source" {
    type = varchar(100)
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}

table "GenerationRequest" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
    default = sql("uuidv7()")
  }
  column "createdAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "updatedAt" {
    type = timestamptz
    null = false
    default = sql("NOW()")
  }
  column "cardCount" {
    type = integer
    null = false
  }
  column "cardSetId" {
    type = varchar(255)
    null = false
  }
  column "category" {
    type = varchar(255)
    null = false
  }
  column "difficulty" {
    type = varchar(255)
    null = false
  }
  column "language" {
    type = varchar(255)
    null = false
  }
  column "status" {
    type = varchar(255)
    null = false
  }
  column "topic" {
    type = varchar(255)
    null = false
  }
  column "userId" {
    type = varchar(255)
    null = false
  }

  // Enrichment columns for rpk bloblang pipeline output
  column "processed_at" {
    type = timestamptz
    null = true
  }
  column "source" {
    type = varchar(100)
    null = true
  }

  primary_key {
    columns = [column.id]
  }
}


// TODO: Future CEL validation via pg_jsonschema extension
// Complex validation patterns from protobuf CEL expressions will be added here
// when pg_jsonschema integration is implemented

// TODO: Add indexes and triggers
// Atlas syntax needs investigation for indexes and triggers