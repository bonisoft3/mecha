---
type: decision
title: Content-addressed blobs
description: A blob key may name its bytes by their SHA-256, and the airlock reads only such keys, checking the bytes against the key, so a handler's repeated run reads what the first one read or stops. An effect's answer is stored under one. Provisional, built for the print order.
status: provisional
---

# Content-addressed blobs

**Status: provisional, to be improved, 5 November 2026.** Built for one use, the
print order in Snapcards, and for the airlock's reads and answers alone. Write-time
checks are not built; see [what is left](#what-is-left).

## The problem

An effect's input is frozen into the ledger at its claim, so a handler that is run
again sees the same input. When the input names a blob, that guarantee stops at the
key: the blob plane keys an upload by a name its writer picked
([the authorized blob plane](2026-10-08-authorized-blob-plane.md)), and the bytes behind that name can change.
On Compose the claimant can write its key again, since rclone's S3 server ignores
`If-None-Match`. A repeated run could then read other bytes than the first one did,
and send a different attachment for the same ledger key.

The bytes cannot go in the input instead: a deck's artwork is up to 16 MiB, and the
ledger keeps every input.

## The decision

A blob key may be `<sha256 hex of the bytes>[-<suffix>].<extension>`. The airlock
reads only such keys: a handler asks `sink.blob(key)`, and the host
([`blobs.ts`](../../services/airlock/blobs.ts)'s `contentBlob`) refuses any other
key, reads the bytes from the plane, and fails the run when they do not hash to the
key. A repeated run reads identical bytes or stops, loudly. The input carries keys,
never bytes, and nothing new is stored.

Snapcards' print checkout keys each card's artwork this way, with WebCrypto and
the order's id as the suffix, and its session handler reads the artwork to make the
order's PDF.

An effect's answer is keyed the same way. The host stores each `$blob` an answer
carries at `effects/<sha256 hex>.<extension>`, and the read accepts that prefix.
No claim can name it, since a claimed key has no `/`, so only the host writes
there. A row keeps the key the outcome settled, and a later effect whose input
carries it reads it with `sink.blob`: Snapcards' record and alert mails attach
the PDF the session handler stored, the bytes the order was paid with. A run
that is retried with the same bytes writes the same object; a handler whose
bytes differ by attempt leaves one object per attempt, read by none.

The suffix is there because a key is one session's claim: two orders of the same
deck, by different people, would otherwise ask for the same key, and the second
would be refused. Identical artwork is therefore stored once per order, not once.
Checking for a stored key first does not help: the browser reports each `404` as a
console error, and the second claim is refused all the same. The claim function's
key pattern grew from 64 to 128 characters to take the suffix.

## What is left

- **No write-time check.** Nothing verifies an upload against its key when it is
  written. On the edge the Worker could hash the body before storing it; R2's `put`
  may take an expected SHA-256, which has not been checked. On Compose the door
  cannot see the body during its authorization, and whether rclone's S3 server
  verifies a checksum is unknown, so it would take a verifying step in the write
  path.
- **On Compose a claimant can still overwrite its own key.** The airlock then
  refuses the bytes, so the harm stays with that claimant's own order; nobody else's
  is exposed.
- **Prodigi fetches raw bytes with no verification.** The lab reads the artwork's
  public route, so a key overwritten after the order is placed would print what it
  then holds.
- **Stored once per order.** Sharing one key across claimants needs a write the
  plane verifies, so another session's upload cannot replace bytes an order
  depends on; until then each order keeps its own copy.
- **Few users.** Content keys are a convention of the print checkout, the
  host's key for an answer's bytes, and a rule of the airlock's read. Other uploads keep names their writers pick, and
  nothing else in the plane knows a key is content-addressed.

## Rejected

- **Bytes in the effect's input.** The ledger keeps every input, and a deck is up
  to 16 MiB of artwork.
- **A write-once plane first.** It would need conditional writes the Compose store
  does not honour; the read-side check gives the airlock its guarantee now, and the
  write side is the improvement this record leaves open.
