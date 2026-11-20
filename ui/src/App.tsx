// A small, ready-made UI to try your API. It is not graded and you do not have to change it.
import { useCallback, useEffect, useState } from "react";

type Status = "todo" | "in-progress" | "done";
type Task = { id: number; title: string; status: Status; priority?: string };
type Page = { items: Task[]; page: number; limit: number; total: number };

const NEXT: Record<Status, Status> = {
  "todo": "in-progress",
  "in-progress": "done",
  "done": "todo",
};

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export default function App() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async (t: string) => {
    try {
      const data: Page = await call("/api/tasks", t);
      setTasks(data.items);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (token) load(token);
  }, [token, load]);

  async function auth(kind: "register" | "login") {
    setMessage("");
    try {
      await call(`/auth/${kind}`, "", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }).then(
        async (r) => {
          if (kind === "login") setToken(r.token);
          else {
            const l = await call("/auth/login", "", {
              method: "POST",
              body: JSON.stringify({ email, password }),
            });
            setToken(l.token);
          }
        },
      );
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await call("/api/tasks", token, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setTitle("");
      load(token);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function advance(t: Task) {
    try {
      await call(`/api/tasks/${t.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ title: t.title, status: NEXT[t.status] }),
      });
      load(token);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function remove(t: Task) {
    try {
      await call(`/api/tasks/${t.id}`, token, { method: "DELETE" });
      load(token);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  return (
    <main
      style={{ maxWidth: 520, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}
    >
      <h1>Tasks UI</h1>
      {message && <p role="alert" style={{ color: "#b00020" }}>{message}</p>}
      {!token
        ? (
          <section>
            <input
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />{" "}
            <input
              placeholder="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />{" "}
            <button onClick={() => auth("login")}>Log in</button>{" "}
            <button onClick={() => auth("register")}>Register</button>
          </section>
        )
        : (
          <section>
            <p>
              Logged in.{" "}
              <button
                onClick={() => {
                  setToken("");
                  setTasks([]);
                }}
              >
                Log out
              </button>
            </p>
            <form onSubmit={add}>
              <input
                placeholder="New task"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />{" "}
              <button>Add</button>
            </form>
            <ul>
              {tasks.map((t) => (
                <li key={t.id}>
                  {t.title} <button onClick={() => advance(t)}>{t.status}</button>{" "}
                  <button onClick={() => remove(t)} aria-label="delete">x</button>
                </li>
              ))}
            </ul>
          </section>
        )}
    </main>
  );
}
