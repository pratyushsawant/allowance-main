/** Renders and evaluates the Quicknode Streams filter (streams/filter.template.js). */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const templatePath = new URL("../streams/filter.template.js", import.meta.url);

export function renderFilter(chainId: number, watched: readonly string[]): string {
  const addresses = watched.map((a) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Not an address: ${a}`);
    return a.toLowerCase();
  });
  if (addresses.length === 0) throw new Error("Watch at least one address");
  return readFileSync(templatePath, "utf8")
    .replace("'__CHAIN_ID__'", JSON.stringify(String(chainId)).replace(/"/g, "'"))
    .replace("__WATCHED__", JSON.stringify(addresses));
}

/** Runs the rendered filter's main(stream) in an isolated context, as Quicknode would. */
export function runFilter(source: string, stream: unknown): unknown {
  const sandbox: Record<string, unknown> = { input: JSON.parse(JSON.stringify(stream)) };
  // Serialize the output, as Quicknode does before delivery (also moves it out of the vm realm).
  const output = runInNewContext(`JSON.stringify((function(){\n${source}\n;return main(input);})())`, sandbox, { timeout: 1000 }) as string;
  return JSON.parse(output);
}
