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


// TODO: Future CEL validation via pg_jsonschema extension
// Complex validation patterns from protobuf CEL expressions will be added here
// when pg_jsonschema integration is implemented

// TODO: Add indexes and triggers
// Atlas syntax needs investigation for indexes and triggers