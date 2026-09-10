package database

import (
	schemas "github.com/bonisoft3/mecha:tmpl"
)

"schema.hcl": {
	entities: [
		{
			name:   "hello"
			schema: schemas.Hello
		},
		{
			name:   "grouphello"
			schema: schemas.GroupHello
		},
	]
}
