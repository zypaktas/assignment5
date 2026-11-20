// Zeynep Sudem Aktaş, 2025502009
// Bonus 13: WebSocket live updates.
import { assert, assertEquals } from "@std/assert";
import { call, freshApp, signUp } from "./helpers.ts";
import { Hub } from "../src/hub.ts";
import { createApp } from "../src/app.ts";
import { closeDb, createDb, migrate } from "../src/db.ts";

Deno.test("GET /ws with a bad or missing token is 401 (checked before the upgrade)", async () => {
  const app = await freshApp();
  for (const path of ["/ws", "/ws?token=", "/ws?token=nonsense"]) {
    const res = await call(app, "GET", path);
    assertEquals(res.status, 401, path);
    assertEquals(res.json.error, "unauthorized");
  }
});

Deno.test("GET /ws with a good token but without an upgrade request is 426", async () => {
  const app = await freshApp();
  const token = await signUp(app, "a@example.com");
  const res = await call(app, "GET", `/ws?token=${token}`);
  assertEquals(res.status, 426);
});

Deno.test("the hub sends to the sockets of one user only", () => {
  const hub = new Hub();
  const got: Record<string, string[]> = { a1: [], a2: [], b1: [] };
  const sock = (name: string) => ({ send: (d: string) => got[name].push(d) });
  const [a1, a2, b1] = [sock("a1"), sock("a2"), sock("b1")];
  hub.add(1, a1);
  hub.add(1, a2);
  hub.add(2, b1);
  hub.broadcast(1, { type: "task.created", task: { title: "x" } });
  assertEquals(got.a1.length, 1);
  assertEquals(got.a2.length, 1);
  assertEquals(got.b1.length, 0, "user 2 must not see user 1's change");
  assertEquals(JSON.parse(got.a1[0]), { type: "task.created", task: { title: "x" } });

  hub.remove(1, a1);
  hub.broadcast(1, { type: "task.deleted", task: {} });
  assertEquals(got.a1.length, 1, "a closed socket gets nothing more");
  assertEquals(got.a2.length, 2);
  assertEquals(hub.count(1), 1);
  hub.remove(1, a2);
  assertEquals(hub.count(1), 0);
});

Deno.test("the hub survives a socket that throws on send", () => {
  const hub = new Hub();
  let received = 0;
  hub.add(1, {
    send: () => {
      throw new Error("closed");
    },
  });
  hub.add(1, { send: () => void received++ });
  hub.broadcast(1, { type: "task.updated", task: {} });
  assertEquals(received, 1);
});

Deno.test("a real server: two tabs of one user see a change at once, another user sees nothing", async () => {
  const file = await Deno.makeTempFile({ suffix: ".db" });
  const db = createDb(`file:${file}`);
  await migrate(db);
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    createApp(db, { log: () => {} }).fetch,
  );
  const base = `http://localhost:${server.addr.port}`;
  const api = async (path: string, method: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  };
  const tokenFor = async (email: string) => {
    await api("/auth/register", "POST", undefined, { email, password: "secret123" });
    return (await api("/auth/login", "POST", undefined, { email, password: "secret123" }))
      .token as string;
  };
  const open = (token: string) => {
    const messages: { type: string; task: { title: string } }[] = [];
    const ws = new WebSocket(`ws://localhost:${server.addr.port}/ws?token=${token}`);
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    const opened = new Promise<void>((r) => (ws.onopen = () => r()));
    const closed = new Promise<void>((r) => (ws.onclose = () => r()));
    return { ws, messages, opened, closed };
  };

  const a = await tokenFor("a@example.com");
  const b = await tokenFor("b@example.com");
  const tab1 = open(a);
  const tab2 = open(a);
  const other = open(b);
  await Promise.all([tab1.opened, tab2.opened, other.opened]);

  await api("/api/tasks", "POST", a, { title: "live!" });
  for (let i = 0; i < 50 && (tab1.messages.length < 1 || tab2.messages.length < 1); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assertEquals(tab1.messages.map((m) => [m.type, m.task.title]), [[
    "task.created",
    "live!",
  ]]);
  assertEquals(tab2.messages.length, 1);
  assertEquals(other.messages.length, 0);

  for (const t of [tab1, tab2, other]) t.ws.close();
  await Promise.all([tab1.closed, tab2.closed, other.closed]);
  await server.shutdown();
  closeDb(db);
  assert(true);
});
