import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

// Production: the first admin needs the SETUP_KEY secret, typed into the form.
const KEY = "Ab+c/1&2#3%x=";   // a generated key with characters a URL would mangle
const prod = { ...env, APP_ENV: "production", SETUP_KEY: KEY };
async function post(body: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request("https://ops.test/setup", { method: "POST", body: new URLSearchParams(body), redirect: "manual" }), prod, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}
const users = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;

describe("first-run setup in production", () => {
  it("shows the form with a setup key field", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://ops.test/setup"), prod, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="key"');
  });
  it("refuses a wrong key and creates no user", async () => {
    const r = await post({ key: "wrong", name: "A", email: "a@b.in", password: "long enough pw" });
    expect(r.status).toBe(403);
    expect(r.text).toContain("match the SETUP_KEY secret");
    expect(await users()).toBe(0);
  });
  it("accepts the key with any characters, and closes afterwards", async () => {
    const r = await post({ key: KEY, name: "Febin", email: "febin@bareskinscience.in", password: "long enough pw" });
    expect(r.status).toBe(302);
    expect(r.location).toBe("/settings?ok=welcome");
    expect(await users()).toBe(1);
    expect((await post({ key: KEY, name: "X", email: "x@y.in", password: "long enough pw" })).location).toBe("/login");
  });
});
