// libraries/mecha/bayt.cue — source-only bayt project for the mecha
// TypeScript packages.
//
// mecha has no image of its own; it exists so bun-workspace consumers
// (guis/snapcards, whose bun.lock links ../../libraries/mecha/packages/*)
// can pull the package sources into their build context via a cross-project
// srcs dep: `deps: ["libraries_mecha:setup:srcs"]`. Mirrors how omnishell
// exposes `plugins_omnishell:build:srcs`.
//
// Bun project (github backend for bun; the core mise plugin picks the musl
// variant that fails on the glibc nubox base). Only setup is modelled — the
// package build/test loop lives in mecha's own Taskfile for now.
package mecha

import (
	bayt "bonisoft.org/plugins/bayt/core:bayt"
	mise "bonisoft.org/plugins/bayt/stacks/mise"
	sayt "bonisoft.org/plugins/bayt/stacks/sayt"
)

_mecha: bayt.#project & {
	dir:      "libraries/mecha"
	activate: "mise x --"

	targets: {
		// Public so bun-workspace consumers COPY the package sources
		// (`libraries_mecha:setup:srcs`). Sources cover every workspace
		// member plus the root manifests bun install resolves against.
		"setup": sayt.setup & mise.install & {
			// packages/** covers the workspace members plus packages/{package.json,
			// bun.lock} — mecha's bun root lives under packages/, not at dir root.
			visibility: "public"
			srcs: globs: ["packages/**"]
			dockerfile: bayt.nubox
		}
		"doctor": sayt.doctor & mise.doctor

		// build = lint mecha's proto definitions. No emitted image (consumed as
		// source via setup:srcs); FROM :setup for the buf toolchain. CUE
		// type-checking lives in test, which regenerates gen/ (buf:generate dep)
		// that the tmpl embeds need.
		"build": sayt.build & mise.exec & {
			srcs: globs: ["proto/**"]
			cmd: "builtin": do: "buf lint proto"
			dockerfile: from: ref: ":setup"
		}
	}
}

project: _mecha
