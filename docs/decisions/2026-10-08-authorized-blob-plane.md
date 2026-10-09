---
type: decision
title: An authorized blob plane
description: Closes the blob plane at the proxy, publishes images only through signed imgproxy URLs computed in SQL, and lets row policy own attachment, so an app needs no media service of its own.
status: unbuilt
---

# An authorized blob plane

**Status: unbuilt, proposed 8 October 2026.** Nothing here is built. The spikes under
[Before building](#before-building) decide whether it is.

## The problem

[The blob plane](../capabilities.md#the-blob-plane) authorizes nothing: anyone
who reaches `/blobs` can list, read, overwrite and delete every object, and
anyone who reaches `/img` can make imgproxy transform any of them. That is a
fine development posture and no posture for user uploads.

GolAberto needed avatars and team logos that only their owner or an editor can
change, so it switched the plane off and shipped a hatch instead: a Deno
gateway that occupies the `rclone-s3` address, verifies the bearer, decodes
and re-encodes every image with sharp, and stores the bytes in PostgreSQL
(`hatch-native-media`, migration 041). It works and it passes its checks, but
it is 315 lines of imperative service, a native image library, image bytes in
the database, and a service squatting a name the shared Caddyfile hard-codes.
Every app with uploads would write its own.

## The proposal

Keep rclone-s3 and imgproxy. Authorize at the door and in the database, which
is where mecha already authorizes everything else.

1. **The object key names, it does not authorize.** The shell already mints
   `<uuid><ext>` keys ([omnishell's upload](../../../../plugins/omnishell/interpreter/screen.js)),
   so a key cannot be guessed, but it is not secret either: once published,
   every page that shows the image carries it. Who may write a key is a row's
   question, below.
2. **The raw bucket accepts writes and nothing else.** Caddy answers `PUT
   /blobs/mecha-objects/<key>` and refuses `GET`, `HEAD`, `DELETE` and every
   bucket-level request, listing included. Raw bytes are never served: an
   upload can be HTML or SVG, and served from the app's own origin it would be
   script on that origin.
3. **A write is a row first.** The `PUT` route runs `forward_auth` against
   PostgREST, calling a SQL function such as `claim_upload(key)`. PostgREST
   already verifies the auth service's HS256 tokens, so the function reads the
   caller through `auth_uid()` and records the key as that account's pending
   upload. It refuses a guest, an account over its quota of pending keys, a
   key another account already claimed, and a key that is attached to any row.
   That last refusal is what keeps published bytes fixed: the key is public,
   but no account may write it once it is in use.
4. **Attaching is a row write.** An avatar or logo column holds a key, and
   row-level policy decides who may set it, exactly as it decides who may set
   any other column. The policy also requires the key to be the caller's own
   pending upload, so an account cannot attach bytes someone else uploaded.
5. **Images are published only through imgproxy, signed.** A read view
   computes `/img/<signature>/<options>/<source>` with pgcrypto's HMAC, keyed
   by imgproxy's signing key and salt, so a page can request only the
   renderings the view chose, not arbitrary transformations of any object.
   The signature does not hide the key: the source segment is plain or
   base64. imgproxy re-encodes whatever it serves, bounds the source (50
   megapixels today), and strips metadata, which is what the gateway's sharp
   pipeline does by hand.
6. **Bytes are written once.** Rule 3 already refuses a write to an attached
   key. If rclone honours `If-None-Match: *` on `PUT`, the route requires it as
   well, so even a key's own uploader cannot replace bytes between attaching
   and the claim being checked.

What an app then declares is a column of type key and a policy, and what it
ships is nothing.

## What it removes and what it costs

It removes GolAberto's gateway, its sharp dependency, the `golaberto_upload`
schema's byte storage, and the name collision on `rclone-s3`.

It costs four things the gateway has today:

- **Validation at upload time.** The gateway refuses a bad image when it
  arrives; here a bad upload is discovered when imgproxy first renders it, and
  the form has already saved the key. A row policy can only check the key's
  shape, not the bytes. Whether that is acceptable is the first question to
  put to the owner of each upload form.
- **Cleanup of abandoned uploads.** Bytes nobody attaches stay in the bucket.
  The gateway expires them because they live in rows. Here they need a
  sweeper, and schedulers are deferred work, or a bucket lifecycle rule where
  the cloud bucket has one. At archive scale the waste is small.
- **A signing key in the database.** The read view must hold imgproxy's key
  and salt. They belong with the other secrets the database is given at start,
  and a leak lets an attacker render any object, which is what `insecure`
  allows today.
- **A claim table.** Rules 3 and 4 need one row per pending or attached key,
  which is the part of the gateway's `golaberto_upload.object` table that
  holds no bytes.

## Alternatives

- **Keep per-app gateways.** What GolAberto ships. Correct, and every app
  re-implements bearer checks, decoding and storage.
- **Presigned URLs.** S3's own answer, but it needs a signer that holds bucket
  credentials and runs per request, which is a service again.
- **Bytes in PostgreSQL for every app.** Puts every upload in the WAL, the
  change feed and every backup, which the blob plane exists to avoid.

## Before building

None of these is verified, and each decides part of the design:

1. Does `rclone serve s3` honour a conditional `PUT` (`If-None-Match: *`)? If
   not, rule 6 rests on rule 3's claim alone, which leaves a window between a
   claim check and the write.
2. Does a signature computed in PostgreSQL with pgcrypto validate in
   imgproxy v3.31.1, byte for byte, for the URL shapes a page needs?
3. Does Caddy's `forward_auth` pass the `Authorization` header and the key to
   PostgREST, map its 401 and 403 to the client unchanged, and hold the request
   body until the check returns? A `forward_auth` subrequest is a `GET` by
   default, so the claim must be made by a function PostgREST will run for one.
4. Measure imgproxy on GolAberto's real logo set: first render latency, and
   whether its trimming and fit options reproduce the Rails crops the gateway
   reproduces today.

## Migration

Existing GolAberto media would move once: each stored rendering is written to
the bucket under its key, the avatar and logo views switch to signed URLs, and
migration 041's byte tables and the gateway go away. Image URLs change shape,
so the switch ships with the views in one release.
