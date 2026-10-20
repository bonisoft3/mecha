import { isoBase64URL, isoCBOR, isoUint8Array, toHash } from "@simplewebauthn/server/helpers";

// A passkey as a browser makes one, for tests: an EC2 P-256 key under a
// "none" attestation for the relying party `rpId`, and client data naming the
// page's origin. The auth service's tests and the edge cluster's share it.
type Cbor = Parameters<typeof isoCBOR.encode>[0];
export async function testPasskey(rpId = "localhost") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const id = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = await toHash(isoUint8Array.fromUTF8String(rpId));
  const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(bytes);
  const clientData = (type: string, challenge: string, origin: string) =>
    isoUint8Array.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  // WebCrypto signs r||s; WebAuthn carries ECDSA signatures as DER.
  const der = (sig: Uint8Array) => {
    const int = (n: Uint8Array) => {
      let i = 0;
      while (i < n.length - 1 && n[i] === 0) i++;
      const v = n[i] & 0x80 ? [0, ...n.slice(i)] : [...n.slice(i)];
      return [0x02, v.length, ...v];
    };
    const body = [...int(sig.slice(0, 32)), ...int(sig.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
  };
  return {
    register(challenge: string, origin: string) {
      const key = isoCBOR.encode(
        new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]),
      );
      const authData = isoUint8Array.concat([
        rpIdHash,
        new Uint8Array([0x41, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, id.length]),
        id,
        key,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]),
      );
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        response: { clientDataJSON: b64(clientData("webauthn.create", challenge, origin)), attestationObject: b64(attestation) },
        clientExtensionResults: {},
      };
    },
    async login(challenge: string, origin: string) {
      const authData = isoUint8Array.concat([rpIdHash, new Uint8Array([0x01, 0, 0, 0, 1])]);
      const data = clientData("webauthn.get", challenge, origin);
      const signed = isoUint8Array.concat([authData, await toHash(data)]);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(signed)));
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(der(sig)) },
        clientExtensionResults: {},
      };
    },
  };
}
