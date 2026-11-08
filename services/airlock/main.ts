// Airlock: loads effects.json and admits every handler, dying on one it
// refuses, holds this process's liveness, and runs every external effect a
// guard enqueues to an outcome (airlock.ts). Port 9997 opens once all of that
// is up: the cluster's healthcheck, and the ticker's wake, which GETs /healthz
// so that a cluster scaled to zero brings this process up for what a guard
// enqueued meanwhile.

import pg from "pg";
import { hold, start } from "./airlock.ts";
import { daprBlobs } from "./blobs.ts";
import { admitAll, meshTransport } from "./handler.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const connectionString = required("DATABASE_URL");
  const mesh = required("MESH_URL");
  const dir = required("AIRLOCK_DIR");
  const { effects, handlers } = await admitAll(`${dir}/effects.json`, dir);
  // Where a bridge names its targets, the release names this one.
  const target = Object.values(effects).some((e) => e.bridge !== undefined) ? required("AIRLOCK_TARGET") : undefined;
  // Read once here and handed to the handler at each call; written nowhere, not
  // the manifest and not the ledger.
  const secrets = Object.fromEntries(
    Object.entries(effects).map(([name, e]) => [name, Object.fromEntries((e.secrets ?? []).map((s) => [s, required(s)]))]),
  );
  // The credential a sink reads from a header: read here, added by the host
  // to each call, and handed to no handler.
  const headerValue = (name: string) => {
    const value = required(name);
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`${name}: a header value is visible ASCII with no space; a mounted file's trailing newline is the usual cause`);
    return value;
  };
  const headers = Object.fromEntries(
    Object.entries(effects).map(([name, e]) => [
      name,
      e.credential === undefined ? {} : { [e.credential.header]: `${e.credential.scheme === undefined ? "" : e.credential.scheme + " "}${headerValue(e.credential.secret)}` },
    ]),
  );
  const db = new pg.Pool({ connectionString });
  const { key } = await hold(connectionString);
  // Set where the cluster has a blob plane: the URL a stored key is served at.
  const blobUrl = Deno.env.get("BLOB_URL");
  const blobs = blobUrl === undefined ? undefined : daprBlobs(mesh, blobUrl);
  // A release with no origin yet runs every effect that does not link back.
  const origin = Deno.env.get("ORIGIN");
  const runner = await start({ connectionString, db, effects, handlers, transport: meshTransport(mesh), secrets, headers, blobs, origin, target }, key);
  Deno.serve({ hostname: ["local", "host"].includes(Deno.env.get("SAYT_PLATFORM") ?? "") ? "127.0.0.1" : "0.0.0.0", port: Number(Deno.env.get("PORT") || 9997), onListen() {} }, (req) => new Response(null, { status: new URL(req.url).pathname === "/healthz" ? 204 : 404 }));
  await runner.promise;
  // On a signal Graphile returns its jobs and ends the process itself; a
  // worker that stops otherwise has nothing left to run.
  throw new Error("the airlock's worker stopped");
}
