// Mirror-only module declaration. Copybara stages this file from
// libraries/mecha/.mirror/cue.mod/ to the bonisoft3/mecha root as
// cue.mod/module.cue. The monorepo itself has no cue.mod here —
// in-monorepo CUE imports resolve against the root cue.mod
// (bonisoft.org). Copybara rewrites import paths from
// github.com/bonisoft3/mecha → github.com/bonisoft3/mecha during
// sync so the mirror is a self-contained CUE module.
module: "github.com/bonisoft3/mecha@v0"

language: {
	version: "v0.16.1"
}

source: {
	kind: "git"
}

// bayt.cue and the .bayt/ it generates import the build vocabulary, which
// the mirror resolves from the Central Registry. `cue mod publish` refuses an
// untidy module, and `cue mod tidy` writes this block by fetching the latest
// version — a write the publish would then refuse as an unclean tree. Stating
// it here keeps the mirror publishable from a pure copy, and the `cue mod
// tidy --check` the mirror's cd.yml runs before publishing is what fails when
// this version falls behind.
deps: {
	"github.com/bonisoft3/bayt@v0": {
		v:       "v0.52.0"
		default: true
	}
}
