#!/usr/bin/env nu
# Benchmark: stack startup time + CRUD + CDC pipeline latency.
# Usage:
#   nu scripts/benchmark.nu                    # cdc profile, 3 iterations
#   nu scripts/benchmark.nu --profile stream
#   nu scripts/benchmark.nu --iterations 10
#
# Runs natively on Windows, macOS, and Linux via Nushell.

def profile-args [name: string] {
    match $name {
        "crud"   => []
        "cdc"    => [--profile sync --profile cdc]
        "stream" => [--profile sync --profile cdc --profile stream]
        _ => (error make {msg: $"unknown profile: ($name)"})
    }
}

def wait-until [--timeout: duration = 3min, block: closure] {
    let deadline = (date now) + $timeout
    mut elapsed = 0ms
    loop {
        if (do $block) { return $elapsed }
        if (date now) > $deadline { error make {msg: $"timeout after ($timeout)"} }
        sleep 200ms
        $elapsed = $elapsed + 200ms
    }
}

def time-block [block: closure] {
    let start = (date now)
    do $block
    (date now) - $start
}

# --- Stack startup ---------------------------------------------------

def "main startup" [--profile: string = "cdc"] {
    let args = profile-args $profile
    let all = [--profile sync --profile cdc --profile stream --profile blobs]

    print $"=== Startup ((ansi cyan))($profile)(ansi reset) ==="
    ^docker compose ...$all down -v out+err> (if $nu.os-info.name == "windows" { "nul" } else { "/dev/null" })
    sleep 1sec

    let started = time-block {
        ^docker compose ...$args up -d --wait
    }

    let services = (^docker compose ...$args ps --format json | lines | each { from json })
    let healthy = ($services | where state == "running" | length)

    print $"  total:     ($started)"
    print $"  services:  ($healthy)"
    $started
}

# --- CRUD latency ----------------------------------------------------

def "main crud" [--iterations: int = 10] {
    print $"=== CRUD Insert Latency \(($iterations) runs\) ==="

    let samples = (1..$iterations | each { |i|
        time-block {
            http post http://localhost:8080/crud/Hello {message: $"bench-($i)"} | ignore
        } | into int | $in / 1000000  # ns → ms
    })

    let stats = ($samples | math avg | into int)
    let min = ($samples | math min | into int)
    let max = ($samples | math max | into int)

    $samples | each { |s| print $"  insert: ($s)ms" }
    print $"  mean=($stats)ms  min=($min)ms  max=($max)ms"
}

# --- CDC pipeline latency --------------------------------------------

def "main cdc" [--iterations: int = 5] {
    print $"=== CDC Pipeline Latency \(insert → enrichment\) ==="

    let samples = (1..$iterations | each { |i|
        let tag = $"bench-cdc-($i)-(random chars -l 8)"
        let start = (date now)

        http post http://localhost:8080/crud/Hello {message: $tag} | ignore

        try {
            wait-until --timeout 30sec {
                let r = (try {
                    http get $"http://localhost:8080/crud/Hello?message=eq.($tag)&processed_at=not.is.null"
                } catch { [] })
                ($r | length) > 0 and (($r | first).source? == "mecha-rpk")
            }
            let elapsed = ((date now) - $start | into int | $in / 1000000)
            print $"  pipeline ($i): ($elapsed)ms"
            $elapsed
        } catch {
            print $"  pipeline ($i): TIMEOUT"
            null
        }
    } | compact)

    if ($samples | length) > 0 {
        let stats = ($samples | math avg | into int)
        print $"  mean=($stats)ms  n=($samples | length)"
    }
}

# --- Run everything --------------------------------------------------

def main [
    --profile: string = "cdc"       # crud | cdc | stream
    --iterations: int = 5            # number of iterations for each benchmark
] {
    print $"Mecha v2 Benchmark"
    print $"Profile:    ($profile)"
    print $"Iterations: ($iterations)"
    print $"Date:       (date now | format date '%Y-%m-%dT%H:%M:%S')"
    print ""

    main startup --profile $profile
    print ""
    main crud --iterations $iterations
    print ""
    if $profile != "crud" {
        main cdc --iterations $iterations
    }
    print ""
    print "=== done ==="
}
