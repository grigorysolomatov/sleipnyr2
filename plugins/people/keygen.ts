// Makes this instance's people key pair (plugins/people, docs/PEERS.md).
//   bun plugins/people/keygen.ts
// Prints the private key (put it in the environment file as PEOPLE_KEY=...,
// never in git or the config) and the public key (give it to your peers).
import { generateKeyPairSync } from "node:crypto";
import { keysOf } from "./server.ts";

const der = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
console.log(`PEOPLE_KEY=${der}`);
console.log(`public key (for your peers): ${keysOf(der).pub}`);
