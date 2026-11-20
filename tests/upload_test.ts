// Zeynep Sudem Aktaş, 2025502009
// Bonus 12: attach an image to a task and download it again.
import { assert, assertEquals } from "@std/assert";
import { call, freshApp, makeTask, signUp } from "./helpers.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 9, 8, 7];

function form(bytes: number[] | Uint8Array, name: string, type: string, field = "file") {
  const f = new FormData();
  f.append(field, new File([new Uint8Array(bytes)], name, { type }));
  return f;
}

async function setup() {
  const dir = await Deno.makeTempDir();
  const app = await freshApp({ uploadDir: dir });
  const token = await signUp(app, "a@example.com");
  const task = await makeTask(app, token, { title: "with picture" });
  const upload = (body: FormData, t = token, id = task.id) =>
    call(app, "POST", `/api/tasks/${id}/attachment`, { token: t, body });
  return { app, dir, token, task, upload };
}

Deno.test("upload then download gives back the same bytes with the right content-type", async () => {
  const { app, dir, token, task, upload } = await setup();
  const up = await upload(form(PNG, "holiday.png", "image/png"));
  assertEquals(up.status, 200);
  assertEquals(up.json.hasAttachment, true);

  const down = await app.request(`/api/tasks/${task.id}/attachment`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(down.status, 200);
  assertEquals(down.headers.get("content-type"), "image/png");
  assertEquals([...new Uint8Array(await down.arrayBuffer())], PNG);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a jpeg works too, and a new upload replaces the old file", async () => {
  const { app, dir, token, task, upload } = await setup();
  await upload(form(PNG, "a.png", "image/png"));
  await upload(form(JPEG, "b.jpg", "image/jpeg"));
  assertEquals([...Deno.readDirSync(dir)].length, 1, "the old image was removed");
  const down = await app.request(`/api/tasks/${task.id}/attachment`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(down.headers.get("content-type"), "image/jpeg");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("the file is saved under a generated name, never the user's file name", async () => {
  const { dir, upload } = await setup();
  await upload(form(PNG, "../../etc/passwd.png", "image/png"));
  const names = [...Deno.readDirSync(dir)].map((e) => e.name);
  assertEquals(names.length, 1);
  assert(/^[0-9a-f-]{36}\.png$/.test(names[0]), `generated name: ${names[0]}`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("no file in the form is 400", async () => {
  const { dir, upload } = await setup();
  const empty = await upload(form(PNG, "a.png", "image/png", "wrongfield"));
  assertEquals(empty.status, 400);
  assertEquals(empty.json.error, "file required");
  const text = new FormData();
  text.append("file", "just text, not a file");
  assertEquals((await upload(text)).status, 400);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a file larger than 1 MB is 413", async () => {
  const { dir, upload } = await setup();
  const big = new Uint8Array(1_000_001);
  big.set(PNG);
  const res = await upload(form(big, "big.png", "image/png"));
  assertEquals(res.status, 413);
  assertEquals([...Deno.readDirSync(dir)].length, 0, "nothing was saved");
  // exactly 1 MB is allowed
  const limit = new Uint8Array(1_000_000);
  limit.set(PNG);
  assertEquals((await upload(form(limit, "limit.png", "image/png"))).status, 200);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a type other than png or jpeg is 415, also when the bytes lie about the type", async () => {
  const { dir, upload } = await setup();
  assertEquals((await upload(form([1, 2, 3], "a.txt", "text/plain"))).status, 415);
  assertEquals((await upload(form(PNG, "a.gif", "image/gif"))).status, 415);
  // says image/png but the bytes are text
  const liar = await upload(
    form(new TextEncoder().encode("<script>alert(1)</script>"), "x.png", "image/png"),
  );
  assertEquals(liar.status, 415);
  // says image/jpeg but the bytes are a png
  assertEquals((await upload(form(PNG, "x.jpg", "image/jpeg"))).status, 415);
  assertEquals([...Deno.readDirSync(dir)].length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("only the owner can upload or download (404 for others, 401 without a token)", async () => {
  const { app, dir, task, upload, token } = await setup();
  await upload(form(PNG, "a.png", "image/png"));
  const other = await signUp(app, "b@example.com");
  assertEquals((await upload(form(PNG, "a.png", "image/png"), other)).status, 404);
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}/attachment`, { token: other })).status,
    404,
  );
  assertEquals((await call(app, "GET", `/api/tasks/${task.id}/attachment`)).status, 401);
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}/attachment`, { token })).status,
    200,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a task without an attachment (or an unknown task) is 404 on download", async () => {
  const { app, dir, token, task } = await setup();
  assertEquals(
    (await call(app, "GET", `/api/tasks/${task.id}/attachment`, { token })).status,
    404,
  );
  assertEquals(
    (await call(app, "GET", "/api/tasks/9999/attachment", { token })).status,
    404,
  );
  assertEquals(
    (await call(app, "GET", "/api/tasks/abc/attachment", { token })).status,
    404,
  );
  await Deno.remove(dir, { recursive: true });
});
