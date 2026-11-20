/**
 * Creates backend/.env with fresh Arc Testnet keys and API tokens, or, if .env already exists,
 * APPENDS only the variables it is missing. Never rewrites or removes an existing line.
 * Writes with mode 600 and prints only public addresses and variable names, never secrets.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envPath = new URL("../.env", import.meta.url);
const examplePath = new URL("../.env.example", import.meta.url);

/** Variables this script can create, in dependency order. */
const GENERATED = [
  "BUYER_PRIVATE_KEY", "SELLER_PRIVATE_KEY", "SELLER_ADDRESS",
  "UNLISTED_SELLER_PRIVATE_KEY", "UNLISTED_SELLER_ADDRESS", "AGENT_API_TOKEN", "OPERATOR_API_TOKEN",
  "SESSION_SECRET", "DEMO_ACCESS_CODE", "OPERATOR_ACCESS_CODE",
] as const;

function parse(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) vars.set(m[1], m[2].trim());
  }
  return vars;
}

const exists = existsSync(envPath);
const current = parse(exists ? readFileSync(envPath, "utf8") : "");
const values = new Map<string, string>();
const has = (name: string) => Boolean(current.get(name) || values.get(name));
const val = (name: string) => current.get(name) || values.get(name)!;

for (const name of GENERATED) {
  if (has(name)) continue;
  if (current.has(name)) {
    console.error(`${name} is present but empty in backend/.env; fill it in or remove that line. Nothing changed.`);
    process.exit(1);
  }
  if (name.endsWith("_PRIVATE_KEY")) values.set(name, generatePrivateKey());
  else if (name.endsWith("_ADDRESS")) values.set(name, privateKeyToAccount(val(name.replace("_ADDRESS", "_PRIVATE_KEY")) as `0x${string}`).address);
  else if (name.endsWith("_ACCESS_CODE")) values.set(name, randomBytes(9).toString("base64url")); // 12 chars a person can type
  else values.set(name, randomBytes(32).toString("hex"));
}

if (values.size === 0) {
  console.log("backend/.env already has every generated variable. Nothing changed.");
} else if (!exists) {
  let text = readFileSync(examplePath, "utf8");
  for (const [name, value] of values) {
    const line = new RegExp(`^${name}=.*$`, "m");
    text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text}\n${name}=${value}\n`;
  }
  writeFileSync(envPath, text, { mode: 0o600, flag: "wx" });
  console.log("Created backend/.env (mode 600).");
} else {
  const block = [...values].map(([n, v]) => `${n}=${v}`).join("\n");
  appendFileSync(envPath, `\n# Added by keys:generate ${new Date().toISOString()}\n${block}\n`);
  chmodSync(envPath, 0o600);
  console.log("Appended to backend/.env (mode 600); existing lines untouched.");
}
for (const name of values.keys()) {
  const shown = name.endsWith("_ADDRESS") ? values.get(name) : "(secret, not shown)";
  console.log(`  + ${name} ${shown}`);
}
console.log(`BUYER_ADDRESS ${privateKeyToAccount(val("BUYER_PRIVATE_KEY") as `0x${string}`).address}  <- fund from https://faucet.circle.com (Arc Testnet)`);
