@extern(embed)
package cluster

import (
	"encoding/json"
	"strings"
)

_roleTemplate: _ @embed(file="services/database/roles-template.sql", type=text)
_roleManaged:  _ @embed(file="services/database/roles-managed.sql", type=text)

// Ownership belongs to the deployment's migration session (mecha.roles), never
// to the privileges it happens to hold. External mode only reads catalogs.
#RoleMigration: {
	managed: string
	contract: {
		roles: [string]: {attributes: [string]: bool, settings: *{} | {[string]: string}, notDatabaseOwner: *false | bool}
		memberships:      *{} | {[string]: [...string]}
		exactMemberships: *false | bool
	}
	out: strings.TrimSuffix(strings.Replace(strings.Replace(_roleTemplate, "@@CONTRACT@@", json.Marshal(contract), 1), "@@MANAGED@@", managed, 1), "\n")
}

#TokenRoleAttributes: {
	rolcanlogin:    false
	rolsuper:       false
	rolcreaterole:  false
	rolcreatedb:    false
	rolreplication: false
	rolbypassrls:   false
}

RolesMigration: #RoleMigration & {
	managed: _roleManaged
	contract: {
		roles: {
			for name in ["anon", "app_user"] {
				(name): {attributes: #TokenRoleAttributes, settings: {statement_timeout: "5s", lock_timeout: "2s", idle_in_transaction_session_timeout: "10s"}}
			}
			authenticator: {attributes: {rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false}, settings: {statement_timeout: "5s", lock_timeout: "2s", idle_in_transaction_session_timeout: "10s"}}
			service:       {attributes: {rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: true}, settings: {statement_timeout: "30s", lock_timeout: "5s", idle_in_transaction_session_timeout: "60s"}}
			electric: attributes: {rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: true, rolbypassrls: true}
		}
		memberships: {
            authenticator: ["anon", "app_user", "service"]
            for name in ["anon", "app_user", "service", "electric"] {(name): []}
        }
		exactMemberships: true
	}
}
