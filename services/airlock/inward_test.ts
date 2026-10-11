import { assertEquals, assertThrows } from "@std/assert";
import { inward } from "./inward.ts";

Deno.test("an address is inward when a cluster, its host or its cloud keeps it", () => {
  const inside = [
    "0.0.0.0", "10.0.0.5", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.18.0.5", "192.168.1.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fd00::5", "fe80::1", "ff02::1", "::ffff:172.18.0.5", "::ffff:ac12:5", "64:ff9b::a00:5",
  ];
  const outside = ["1.1.1.1", "172.32.0.1", "100.128.0.1", "198.51.100.7", "2606:4700::1111", "::ffff:1.1.1.1", "64:ff9b::101:101"];
  assertEquals(inside.filter((a) => !inward(a)), []);
  assertEquals(outside.filter((a) => inward(a)), []);
  assertThrows(() => inward("sink.example"));
});

// daprd sends a plain-http target through HTTP_PROXY in absolute form; that
// would be a request the proxy makes on its behalf, so it is refused whatever
// it names.
