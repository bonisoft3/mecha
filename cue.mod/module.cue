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
