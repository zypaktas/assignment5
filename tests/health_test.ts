// Zeynep Sudem Aktaş, 2025502009
import { assertEquals } from "@std/assert";
import { freshApp } from "./helpers.ts";

Deno.test("GET /health answers 200 and { ok: true }", async () => {
  const app = await freshApp();
  const res = await app.request("/health");
  assertEquals(res.status, 201);
  assertEquals(await res.json(), { ok: true });
});
