// Zeynep Sudem Aktaş, 2025502009
// Bonus 13: a real server, two WebSocket clients of the same user and one of another user.
import { createApp } from "../src/app.ts";
import { closeDb, createDb, migrate } from "../src/db.ts";

const file = await Deno.makeTempFile({ suffix: ".db" });
const db = createDb(`file:${file}`);
await migrate(db);
const server = Deno.serve(
  { port: 0, onListen: () => {} },
  createApp(db, { log: () => {} }).fetch,
);
const base = `http://localhost:${server.addr.port}`;

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
  });
  return res.json();
}
async function tokenFor(email: string) {
  const body = JSON.stringify({ email, password: "secret123" });
  await api("/auth/register", { method: "POST", body });
  return (await api("/auth/login", { method: "POST", body })).token as string;
}
function listen(name: string, token: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${token}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    console.log(`  [${name}] ${m.type}: "${m.task.title}" (${m.task.status})`);
  };
  return new Promise<WebSocket>((resolve) => (ws.onopen = () => resolve(ws)));
}

const a = await tokenFor("a@example.com");
const b = await tokenFor("b@example.com");
const tab1 = await listen("A tab 1", a);
const tab2 = await listen("A tab 2", a);
const other = await listen("B tab  ", b);

console.log(
  "User A creates, advances and deletes a task from a third place (curl-like):",
);
const t = await api("/api/tasks", {
  method: "POST",
  token: a,
  body: JSON.stringify({ title: "Buy milk" }),
});
await api(`/api/tasks/${t.id}`, {
  method: "PUT",
  token: a,
  body: JSON.stringify({ title: "Buy milk", status: "done" }),
});
await api(`/api/tasks/${t.id}`, { method: "DELETE", token: a });
await new Promise((r) => setTimeout(r, 300));

const bad = await fetch(`${base}/ws?token=nonsense`);
console.log(
  `A WebSocket with a bad token gets: ${bad.status} ${JSON.stringify(await bad.json())}`,
);
for (const s of [tab1, tab2, other]) s.close();
await server.shutdown();
closeDb(db);
await Deno.remove(file).catch(() => {});
