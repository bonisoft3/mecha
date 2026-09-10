package tmpl

import "tool/exec"

command: generate: {
	run: exec.Run & {
		cmd: [
			"bash",
			"-c",
			"""
set -euo pipefail
# Generate database schema from root CUE entity data
cue export .:tmpl | jq '{entities: .Entities}' | gomplate -d data=stdin:///data.json -f services/database/schemas/schema.hcl.tmpl -o services/database/schemas/schema.hcl
echo "Generated services/database/schemas/schema.hcl"
""",
		]
	}
}
