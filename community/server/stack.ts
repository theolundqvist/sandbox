// A throwaway community API for tests: Postgres and an S3 stand-in (SeaweedFS) in Docker, and the server on a free port.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = async (...args: string[]) => {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(`${args.join(" ")}: ${err}`);
  return out.trim();
};
const hostPort = async (container: string, port: number) => (await run("docker", "port", container, String(port))).split("\n")[0]!.split(":").pop()!;
const until = async (what: string, ok: () => Promise<boolean>) => {
  for (let i = 0; i < 120; i++) {
    if (await ok().catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error(`${what} didn't start`);
};

export type CommunityStack = { api: string; env: Record<string, string>; stop(): Promise<void> };

export async function startStack(site = "https://sandbox.example", extra: Record<string, string> = {}): Promise<CommunityStack> {
  const dir = mkdtempSync(join(tmpdir(), "community-stack-"));
  const name = `community-test-${process.pid}-${Date.now().toString(36)}`;
  const s3 = { accessKeyId: "test", secretAccessKey: "test-secret" };
  writeFileSync(join(dir, "s3.json"), JSON.stringify({ identities: [{ name: "test", credentials: [{ accessKey: s3.accessKeyId, secretKey: s3.secretAccessKey }], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] }));
  await run("docker", "run", "-d", "--rm", "--name", `${name}-db`, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=test", "postgres:17-alpine");
  await run("docker", "run", "-d", "--rm", "--name", `${name}-s3`, "-p", "127.0.0.1::8333", "-v", `${join(dir, "s3.json")}:/s3.json:ro`, "chrislusf/seaweedfs:latest", "server", "-s3", "-s3.config=/s3.json");
  const db = `postgres://postgres:test@127.0.0.1:${await hostPort(`${name}-db`, 5432)}/postgres`;
  const endpoint = `http://127.0.0.1:${await hostPort(`${name}-s3`, 8333)}`;
  await until("Postgres", async () => (await run("docker", "exec", `${name}-db`, "pg_isready", "-h", "127.0.0.1"), true));
  await until("SeaweedFS", async () => (await run("bash", "-c", `echo "s3.bucket.create -name sandbox-worlds" | docker exec -i ${name}-s3 weed shell`), true));
  await until("the bucket", async () => (await fetch(`${endpoint}/sandbox-worlds`)).status !== 404);
  const env = { SITE: site, DATABASE_URL: db, R2_ENDPOINT: endpoint, R2_REGION: "us-east-1", R2_BUCKET: "sandbox-worlds", R2_ACCESS_KEY_ID: s3.accessKeyId, R2_SECRET_ACCESS_KEY: s3.secretAccessKey, ...extra };
  const port = 20000 + Math.floor(Math.random() * 10000);
  const server = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "server.ts")], { env: { ...process.env, ...env, PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
  const api = `http://127.0.0.1:${port}`;
  await until("the community API", async () => (await fetch(`${api}/worlds`)).ok);
  return {
    api,
    env,
    async stop() {
      server.kill();
      await server.exited;
      await run("docker", "rm", "-f", `${name}-db`, `${name}-s3`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
