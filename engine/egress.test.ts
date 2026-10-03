import { afterAll, expect, test } from "bun:test";
import { download, EgressError } from "./egress";

const secret = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("host-key-canary") });
afterAll(() => secret.stop(true));

test.each([`http://127.0.0.1:${secret.port}/api/local-key`, `http://localhost:${secret.port}/`, `http://[::ffff:127.0.0.1]:${secret.port}/`, `http://2130706433:${secret.port}/`, "http://[fd00::1]/", "file:///etc/passwd"])(
  "a builder's download never reaches %s",
  async (url) => {
    await expect(download(url, 1 << 20)).rejects.toBeInstanceOf(EgressError);
  },
);
