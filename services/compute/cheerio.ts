import { load } from "npm:cheerio@1.2.0/slim";

// Harden the capability, not the parser's mutable document or shared prototypes.
// The slim entry point has no network loaders; its documents use htmlparser2.
export const Cheerio = {
	load: (...args: Parameters<typeof load>) => load(...args),
};
