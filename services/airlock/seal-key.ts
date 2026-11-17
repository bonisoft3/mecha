// A new seal key, base64 PKCS#8, on stdout: what a release sets AIRLOCK_SEAL_KEY to (seal.ts).
import { generateSealKey } from "./seal.ts";

console.log(await generateSealKey());
