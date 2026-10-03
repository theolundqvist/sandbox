// Stand-in for sim.ts in network-box.test.ts. Inside the box it installs the brokered network before any mod code runs,
// as the simulation does, then imports the mod and reports its exports and what its run() found.
import { installNetwork } from "./network";

const network = installNetwork((msg) => process.send!(msg));
const done = Promise.withResolvers<void>();
process.on("message", (msg: unknown) => {
  if (network.receive(msg)) return;
  if (msg && typeof msg === "object" && "t" in msg && msg.t === "ack") done.resolve();
});
// The mod is whatever path the test wrote, known only at run time, as the simulation's mods are.
const mod: { name?: unknown; run?: () => Promise<Record<string, unknown>> } = await import(process.argv[2]!);
process.send!({ t: "result", name: mod.name, results: await mod.run?.() });
await done.promise;
process.exit(0);
