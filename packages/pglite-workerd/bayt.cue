// @electric-sql/pglite 0.5.8 built so a Durable Object loads it as built
// (README.md): every stage runs in a pinned image from pinned sources, and
// `package` is the directory `just build` exports to dist/.
package pglite_workerd

import (
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
)

// @electric-sql/pglite@0.5.8 and the postgres-pglite commit it pins, as
// GitHub's archives of those commits.
_pglite: {
	commit: "ae182ff8bd5ba4acb887d6c925d607a1498aa0b5"
	sha256: "10b24517c31d23bbe952fa8cf9810952cd69cc72e8527f842b23125967dbf72c"
}
_postgresPglite: {
	commit: "b133782cd759f08b3aeb263b80a963b39c7b7af1"
	sha256: "31b7d5c46a9501b653536cce2ba593739144981cb0aa25692b678d68505ad2cd"
}
// The ICU 76 data mecha-browser loads, as the registry's tarball.
_icuFull: {
	url:    "https://registry.npmjs.org/@electric-sql/pglite-icu-full/-/pglite-icu-full-0.0.2.tgz"
	sha256: "683455259b053abbc8e31bfea7e2957c44aba4bb5d56c22d5f4e91d5d2680626"
}
// The files a collation over the root locale (`und-u-…`) opens, out of the
// full set's 4,136: an object's isolate holds its data modules in its 128 MB.
_icuRoot: ["icudt76l/res_index.res", "icudt76l/keyTypeData.res", "icudt76l/timezoneTypes.res", "icudt76l/coll/ucadata.icu", "icudt76l/coll/root.res"]
// build-with-docker.sh's image at that commit, emsdk 3.1.74.
_builder: "electricsql/pglite-builder:3.1.74-7@sha256:9e75d29ed19d651b393bf9462bbe770405bd3b26e57d3b76001ac844539835e1"
// The repository's nushell (.mise.toml), a static musl binary.
_nushell: "ghcr.io/nushell/nushell:0.115.1-alpine@sha256:f938ac013d373f4de002900cdc594dab3f2dd55696333e29ed73f48ae724cb77"
// The node the package's build and validate_test.ts were checked under,
// not the repository's; the full image, for the git that applies the patch
// and GNU tar.
_node: "node:22.23.3-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"
// pglite's packageManager, held to the registry tarball's sha512.
_pnpm: "pnpm@9.7.0+sha512.dc09430156b427f5ecfc79888899e1c39d2d690f004be70e05230b72cb173d96839587545d09429b55ac3c429c801b4dc3c0e002f653830a420fa2dd4e3cf9cf"

_archive: {
	_repo: string
	_pin: {commit: string, sha256: string}
	url:    "https://github.com/electric-sql/\(_repo)/archive/\(_pin.commit).tar.gz"
	sha256: _pin.sha256
	dest:   "/src/"
	unpack: true
}

_build: bayt.#project & {
	dir:      "libraries/mecha/packages/pglite-workerd"
	activate: ""

	targets: {
		// pglite.{js,wasm,data} linked for workerd, and the initdb its
		// package carries.
		"wasm": {
			srcs: globs: ["wasm.nu", "patches/postgres-pglite.patch"]
			outs: globs: ["release/**"]
			env: PGLITE_VERSION: "0.5.8"
			dockerfile: {
				from: name: _builder
				defaultPreamble: nu: {priority: -10, copy: {
					from: name: _nushell
					srcs: ["/usr/bin/nu"]
					dst:  "/usr/local/bin/nu"
				}}
				add: [_archive & {_repo: "postgres-pglite", _pin: _postgresPglite}]
			}
			cmd: "builtin": dockerfile: do: "nu wasm.nu /src/postgres-pglite-\(_postgresPglite.commit) release"
		}

		// The TypeScript package over the wasm: pglite's own build, with the
		// patched sources and `wasm`'s release/ in place of upstream's.
		"dist": {
			deps: [":wasm:outs"]
			srcs: globs: ["patches/pglite.patch"]
			outs: globs: ["dist/**"]
			_tree: "/src/pglite-\(_pglite.commit)"
			dockerfile: {
				from: name: _node
				add: [_archive & {_repo: "pglite", _pin: _pglite}]
			}
			cmd: {
				"patch": {
					priority: -3
					shell:    "sh"
					dockerfile: do: "git -C \(_tree) apply \"$PWD/patches/pglite.patch\" && cp -R release \(_tree)/packages/pglite/release"
				}
				"pnpm": {
					priority: -2
					shell:    "sh"
					dockerfile: do: "corepack enable pnpm && corepack install -g \(_pnpm)"
				}
				"install": {
					priority: -1
					dockerfile: {
						do: "pnpm -C \(_tree) install --frozen-lockfile --filter @electric-sql/pglite..."
						mounts: [{type: "cache", target: "/root/.local/share/pnpm/store", scope: "global"}]
					}
				}
				"builtin": {
					shell: "sh"
					dockerfile: do: "pnpm -C \(_tree) -r --filter @electric-sql/pglite... build && cp -R \(_tree)/packages/pglite/dist dist"
				}
			}
		}

		// icu-root.tgz: the root locale's ICU files, archived reproducibly.
		"icu": {
			outs: globs: ["icu/**"]
			dockerfile: {
				from: name: _node
				add: [{url: _icuFull.url, sha256: _icuFull.sha256, dest: "/src/", unpack: true}]
			}
			cmd: "builtin": {
				shell: "sh"
				dockerfile: do: "mkdir -p /tmp/icu icu && tar -xzf /src/package/dist/icu.76.tgz -C /tmp/icu \(strings.Join(_icuRoot, " ")) && tar -C /tmp/icu --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - icudt76l | gzip -n > icu/icu-root.tgz"
			}
		}

		// The package alone at the image's root: what a local export of this
		// target writes is dist/ as wrangler aliases it.
		"package": {
			cmd: "builtin": null
			dockerfile: {
				from:    null
				workdir: "/"
				copy: [
					{from: ref: ":dist", srcs: ["/monorepo/\(_build.dir)/dist/"], dst: "/"},
					{from: ref: ":icu", srcs: ["/monorepo/\(_build.dir)/icu/icu-root.tgz"], dst: "/"},
				]
			}
		}
	}
}

project: _build
