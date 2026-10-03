// Helpers for the API's tests: a throwaway stack, calls from fresh IPs, accounts and published worlds.
import { afterAll, beforeAll, expect } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { startStack } from "./stack";

export const SITE = "https://sandbox.example";
export const kit = { stack: null as unknown as Awaited<ReturnType<typeof startStack>>, db: null as unknown as SQL };
/** Each test file calls this once for its own throwaway stack. */
export function useStack() {
  beforeAll(async () => {
    kit.stack = await startStack(SITE);
    kit.db = new SQL(kit.stack.env.DATABASE_URL);
  }, 120_000);
  afterAll(async () => {
    await kit.db?.close();
    await kit.stack?.stop();
  }, 30_000);
}

let ips = 0;
/** Each call comes from its own IP unless it says otherwise, so the per-IP limits stay out of the way. */
export const freshIp = () => `10.1.${Math.floor(++ips / 250)}.${ips % 250}`;
type Init = { method?: string; body?: unknown; token?: string; ip?: string; headers?: Record<string, string> };
export const call = (path: string, init: Init = {}) =>
  fetch(`${kit.stack.api}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: { "content-type": "application/json", "x-real-ip": init.ip ?? freshIp(), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
  });
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export async function signUp(username: string, password = "correct horse battery", ip?: string) {
  const res = await call("/accounts", { body: { email: ` ${username.toUpperCase()}@Example.com `, password, username }, ip });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; account: { id: string; username: string; email: string } };
}

export const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
export const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
export const share = (token: string, extra: object = {}) => call("/worlds", { token, body: { title: "Keep", visibility: "public", engineVersion: "x", mods: 0, files: { zip: zip.length, cover: jpeg.length }, ...extra } });
export async function publish(token: string, extra: object = {}) {
  const res = await share(token, extra);
  expect(res.status).toBe(201);
  const world = await res.json();
  for (const [kind, body] of [["zip", zip], ["cover", jpeg]] as const) await fetch(world.uploads[kind], { method: "PUT", body, headers: { "content-type": kind === "zip" ? "application/zip" : "image/jpeg" } });
  expect((await call(`/worlds/${world.id}/done`, { method: "POST", token })).status).toBe(200);
  return world as { id: string };
}
