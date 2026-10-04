package cluster

import "strings"

// The service images mecha builds, by service. Its release builds and pushes
// each (cd.yml's matrix lists the same) and prints each one's pin. A consumer
// pins what it builds on: pronto holds the pins (clusters/mecha.cue), checked
// against #Published.
#Images: ["database", "migrate", "mesh", "conduit", "auth", "ticker", "clock", "compute", "rclone-s3"]

// A pin is an image a release pushed to Docker Hub, by version and digest. The
// compose service and fragment an app builds from in the monorepo follow from
// the key (libraries_mecha-<service>-image).
#Pin: =~"^bonitao/mecha-[a-z0-9-]+:[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?@sha256:[0-9a-f]{64}$"
#Published: close({for s in #Images {(s)?: #Pin & strings.HasPrefix("bonitao/mecha-\(s):")}})
