import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
Object.defineProperty(process, "platform", { value: "win32" });
// Load the engine only after selecting the unsupported platform for this isolated smoke.
const { Mods } = await import("../mods");
const { SimHost } = await import("../simhost");
const { boxRefusal } = await import("./index");
const dir = process.argv[2]!;
const root = join(dir, "world");
const build = join(dir, "build");
const db = join(dir, "db");
for (const path of [join(root, "mods"), build, db]) mkdirSync(path, {recursive:true});
cpSync(join(import.meta.dir, "../seed/mods/basics"),join(root,"mods/basics"),{recursive:true});
mkdirSync(join(root,"mods/rogue"));
const marker = join(dir,"outside-canary");
writeFileSync(marker,"unchanged");
const hostile = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'escaped'); export default {};`;
writeFileSync(join(root,"mods/rogue/server.ts"),hostile);
writeFileSync(join(build,"forged.js"),hostile);
const state = JSON.stringify(Object.fromEntries(["basics","rogue"].map((name,i)=>[name,{id:i+1,author:"fixture",version:1,build:{server:"forged.js",client:null},previous:[]}])));
const statePath = join(dir,"mods.json");
writeFileSync(statePath,state);
let tick = () => {};
const notices: string[]=[];
const mods = new Mods(root,build,statePath,{client:()=>false,feed:text=>notices.push(text),record:()=>{}});
await mods.loadAll({});
const active=mods.list();
if(active.map(mod=>mod.name).join(",")!=="basics") throw new Error("Seed verification accepted an untrusted mod or cached build");
if(readFileSync(statePath,"utf8")!==state) throw new Error("Unavailable sandbox overwrote held mod state");
const host=new SimHost(db,()=>mods.list(),{tick:()=>tick(),log:()=>{},fault:(_name,error)=>{throw new Error(error);}});
mods.sims={trial:mod=>host.trial(mod),apply:mod=>host.apply(mod),hasGame:()=>false};
try {
  host.start();
  const arrived=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Trusted seed did not handle join")),5000);
    tick=()=>{if([...host.entities.values()].some(e=>e.player==="seed-player")){clearTimeout(timer);resolve();}};
  });
  host.send({t:"join",player:{id:"seed-player",name:"seed-player",game:null}});
  await arrived;
  const refusal=boxRefusal()!;
  if(!notices.includes(refusal)) throw new Error("Startup did not explain why foreign mods were held");
  const rejected=await mods.reload("rogue","fixture","fixture");
  if(rejected.ok || !rejected.report.includes(refusal)) throw new Error("Reload did not preserve the shared refusal sentence");
  if(readFileSync(marker,"utf8")!=="unchanged") throw new Error("A forged cached build ran outside confinement");
  const unloaded=await host.apply({name:"basics",id:active[0]!.id,server:null,game:null});
  if(unloaded) throw new Error("Trusted seed could not unload");
  host.send({t:"join",player:{id:"after-unload",name:"after-unload",game:null}});
  await host.walk([0,1,0],[0,1,0]);
  if([...host.entities.values()].some(entity=>entity.player==="after-unload")) throw new Error("Unloaded seed still handled a join");
  console.log(JSON.stringify({unavailable:true,trustedSeedRuns:true,forgedBuildRejected:true,foreignReloadRefused:true,heldStatePreserved:true,unload:true}));
  host.stop();
  setTimeout(()=>process.exit(0),750);
} catch(error) {
  host.stop();
  console.error(error instanceof Error?error.message:"Seed smoke failed");
  setTimeout(()=>process.exit(1),750);
}
