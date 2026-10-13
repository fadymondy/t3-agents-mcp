import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { saveCredential } from "../src/credentials.js";
import {
  EnvironmentRegistry,
  loadEnvironments,
  resolveEnvironmentToken,
  toolEnvironments,
  type EnvironmentConfig,
} from "../src/environments.js";
import { makeHttpClient } from "../src/http.js";
import type { T3Api, T3Connection } from "../src/t3.js";
import { registerTools } from "../src/tools.js";

const TOKEN = "remote-secret-token-value";
const REMOTE_ID = "c40aaa1c-04df-4915-898f-73c3215d23da";

const thread = (id: string, title: string, status = "completed") => ({
  id,
  projectId: "p1",
  title,
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  updatedAt: `2026-10-11T00:00:0${id.length % 10}Z`,
  archivedAt: null,
  status,
  latestRunId: "r1",
  activeRunId: status === "running" ? "r1" : null,
});

const projection = (id: string, status: string) => ({
  snapshotSequence: 7,
  projection: {
    thread: thread(id, id === "hosbah" ? "Hosbah" : "Other"),
    runs: [{ id: "r1", ordinal: 1, status, userMessageId: "u1", requestedAt: "2026-10-11T00:00:00Z", startedAt: "2026-10-11T00:00:00Z", completedAt: null }],
    messages: [
      { id: "u1", role: "user", text: "first", runId: "r1", streaming: false, createdAt: "2026-10-11T00:00:00Z" },
      { id: "a1", role: "assistant", text: "second", runId: "r1", streaming: false, createdAt: "2026-10-11T00:00:01Z" },
      { id: "u2", role: "user", text: "third", runId: "r1", streaming: false, createdAt: "2026-10-11T00:00:02Z" },
    ],
  },
});

/** A fake remote T3: the discovery document plus the two bearer-checked HTTP reads the tools use. */
function fakeRemote(): Promise<{ server: Server; origin: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    requests.push(`${url.pathname} ${request.headers.authorization ?? ""}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/t3/environment") {
      response.end(JSON.stringify({ environmentId: REMOTE_ID, label: "fadymondy", serverVersion: "0.0.46-test" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ _tag: "EnvironmentAuthInvalidError" }));
      return;
    }
    if (url.pathname === "/api/orchestration/shell") {
      response.end(JSON.stringify({ snapshotSequence: 1, projects: [{ id: "p1", title: "Sites", workspaceRoot: "C:/Sites", defaultModelSelection: null }], threads: [thread("hosbah", "Hosbah"), thread("busy", "Busy one", "running")] }));
      return;
    }
    const match = url.pathname.match(/^\/api\/orchestration\/threads\/(.+)$/);
    if (match) {
      response.end(JSON.stringify(projection(decodeURIComponent(match[1]!), match[1] === "busy" ? "running" : "completed")));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, origin: `http://127.0.0.1:${address.port}`, requests });
    }),
  );
}

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

describe("environments config", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "t3-envs-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const write = async (value: unknown) => {
    const path = join(dir, `${Math.random()}.json`);
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  it("treats a missing file as no environments", async () => {
    expect(await loadEnvironments(join(dir, "nope.json"))).toEqual([]);
  });

  it("normalizes urls to origins and defaults auth to paired", async () => {
    const path = await write({ environments: [{ name: "windows", url: "http://100.94.96.85:3773/some/path" }] });
    expect(await loadEnvironments(path)).toEqual([{ name: "windows", url: "http://100.94.96.85:3773", auth: { type: "paired" } }]);
  });

  it("names the problem in an invalid file", async () => {
    await expect(loadEnvironments(await write("{"))).rejects.toThrow(/not valid JSON/);
    await expect(loadEnvironments(await write({ environments: [{ name: "local", url: "http://x" }] }))).rejects.toThrow(/reserved/);
    await expect(loadEnvironments(await write({ environments: [{ name: "w", url: "nope" }] }))).rejects.toThrow(/environments\.0\.url/);
    const dup = { environments: [{ name: "w", url: "http://a" }, { name: "W", url: "http://b" }] };
    await expect(loadEnvironments(await write(dup))).rejects.toThrow(/defined twice/);
  });
});

describe("environment tokens", () => {
  const entry = (auth: EnvironmentConfig["auth"]): EnvironmentConfig => ({ name: "windows", url: "http://100.94.96.85:3773", auth });

  it("reads an env var and reports only its name", async () => {
    const result = await resolveEnvironmentToken(entry({ type: "env", var: "WIN_TOKEN" }), { env: { WIN_TOKEN: ` ${TOKEN}\n` } });
    expect(result).toEqual({ token: TOKEN, source: "env WIN_TOKEN" });
    await expect(resolveEnvironmentToken(entry({ type: "env", var: "WIN_TOKEN" }), { env: {} })).rejects.toThrow(/WIN_TOKEN is not set/);
  });

  it("runs a token command without a shell and keeps failures value-free", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return `${TOKEN}\n`;
    };
    const result = await resolveEnvironmentToken(entry({ type: "command", command: ["vault", "get", "t3-windows"] }), { run });
    expect(result.token).toBe(TOKEN);
    expect(calls).toEqual([["vault", "get", "t3-windows"]]);
    const failing = async () => {
      throw new Error("exited with 1");
    };
    await expect(resolveEnvironmentToken(entry({ type: "command", command: ["vault"] }), { run: failing })).rejects.toThrow(/command vault failed \(exited with 1\)/);
  });

  it("reads the macOS keychain and refuses elsewhere", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return TOKEN;
    };
    const auth = { type: "keychain" as const, service: "t3-agents-mcp", account: "windows" };
    await resolveEnvironmentToken(entry(auth), { run, platform: "darwin" });
    expect(calls[0]).toEqual(["security", "find-generic-password", "-s", "t3-agents-mcp", "-a", "windows", "-w"]);
    await expect(resolveEnvironmentToken(entry(auth), { run, platform: "win32" })).rejects.toThrow(/macOS-only/);
  });

  it("explains how to pair when no stored token exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3-envs-cred-"));
    try {
      const env = { T3_MCP_CREDENTIALS: join(dir, "credentials.json") };
      await expect(resolveEnvironmentToken(entry({ type: "paired" }), { env })).rejects.toThrow(/pair --environment windows --stdin/);
      await saveCredential(env.T3_MCP_CREDENTIALS, { origin: "http://100.94.96.85:3773", accessToken: TOKEN, scope: "s", issuedAt: "", expiresAt: "2999-01-01T00:00:00Z" });
      expect((await resolveEnvironmentToken(entry({ type: "paired" }), { env })).token).toBe(TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("remote environments through the MCP tools", () => {
  let remote: Awaited<ReturnType<typeof fakeRemote>>;
  let dir: string;
  let call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  const rpcCalls: Array<{ tag: string; payload: any }> = [];

  beforeAll(async () => {
    remote = await fakeRemote();
    dir = await mkdtemp(join(tmpdir(), "t3-envs-tools-"));
    const path = join(dir, "environments.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        environments: [
          { name: "windows", url: remote.origin, environmentId: REMOTE_ID, auth: { type: "env", var: "WIN_TOKEN" }, description: "think-station" },
          { name: "wrong-token", url: remote.origin, auth: { type: "env", var: "BAD_TOKEN" } },
          { name: "impostor", url: remote.origin, environmentId: "someone-else", auth: { type: "env", var: "WIN_TOKEN" } },
          { name: "down", url: "http://127.0.0.1:9", auth: { type: "env", var: "WIN_TOKEN" }, timeoutMs: 1000 },
          // This machine's own tailnet address, unpaired: must route to local.
          { name: "self", url: "http://127.0.0.1:9", environmentId: "mac-env", auth: { type: "env", var: "NO_TOKEN" }, timeoutMs: 1000 },
        ],
      }),
    );
    const registry = new EnvironmentRegistry(path, {
      env: { WIN_TOKEN: TOKEN, BAD_TOKEN: "nope" },
      // Real HTTP against the fake remote; RPC (search, dispatch) is recorded.
      makeConnection: (server, token, tokenSource): T3Connection => ({
        server,
        tokenSource,
        http: makeHttpClient(server.origin, token),
        rpc: {
          call: async <T>(tag: string, payload: any) => {
            rpcCalls.push({ tag, payload });
            if (tag === "orchestration.searchThreads") {
              return { matches: [{ threadId: "hosbah", projectId: "p1", source: "user", snippet: "install Postiz", messageCreatedAt: null }] } as T;
            }
            return { sequence: 1 } as T;
          },
          stream: async () => undefined,
          close: () => undefined,
        },
      }),
    });

    const server = new McpServer({ name: "test", version: "0" });
    const handlers = new Map<string, Handler>();
    const original = server.registerTool.bind(server);
    (server as unknown as { registerTool: unknown }).registerTool = (name: string, meta: unknown, cb: Handler) => {
      handlers.set(name, cb);
      return original(name, meta as never, cb as never);
    };
    const localApi = { shell: async () => ({ snapshotSequence: 1, projects: [], threads: [] }) } as unknown as T3Api;
    registerTools(server, { api: localApi, origin: "http://127.0.0.1:3773", environmentId: "mac-env" }, toolEnvironments(registry));
    call = async (name, args = {}) => {
      const result = await handlers.get(name)!(args);
      const text = result.content.map((c) => c.text).join("");
      return result.isError ? { error: text } : JSON.parse(text);
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("lists local plus each remote with reachability and authorization", async () => {
    const list = await call("t3_list_environments");
    const byName = Object.fromEntries(list.map((e: { name: string }) => [e.name, e]));
    expect(byName.local).toMatchObject({ local: true, reachable: true, environmentId: "mac-env", authorized: true });
    expect(byName.windows).toMatchObject({ reachable: true, authorized: true, environmentId: REMOTE_ID, label: "fadymondy", projects: 1, threads: 2, tokenSource: "env WIN_TOKEN" });
    expect(byName["wrong-token"]).toMatchObject({ reachable: true, authorized: false });
    expect(byName["wrong-token"].error).toMatch(/pair --environment wrong-token/);
    expect(byName.impostor).toMatchObject({ reachable: false });
    expect(byName.impostor.error).toMatch(/Refusing to send a token/);
    expect(byName.down).toMatchObject({ reachable: false });
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it("never sends the token to a server with the wrong environment id", async () => {
    remote.requests.length = 0;
    expect((await call("t3_list_threads", { environment: "impostor" })).error).toMatch(/Refusing/);
    expect(remote.requests.every((r) => r.startsWith("/.well-known/t3/environment"))).toBe(true);
    expect(remote.requests.some((r) => r.includes(TOKEN))).toBe(false);
  });

  it("lists and filters remote threads, tagged with the environment", async () => {
    const threads = await call("t3_list_threads", { environment: "windows", titleContains: "hosb" });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadId: "hosbah", title: "Hosbah", environment: "windows", environmentId: REMOTE_ID, url: `${remote.origin}/${REMOTE_ID}/hosbah` });
  });

  it("accepts the environment id as well as the name", async () => {
    expect(await call("t3_list_threads", { environment: REMOTE_ID, titleContains: "Hosbah" })).toHaveLength(1);
  });

  it("reads a remote thread's last messages", async () => {
    const result = await call("t3_get_thread", { environment: "windows", threadId: "hosbah", messageLimit: 2 });
    expect(result.messages.map((m: { text: string }) => m.text)).toEqual(["second", "third"]);
  });

  it("searches remote threads and adds titles", async () => {
    const matches = await call("t3_search_threads", { environment: "windows", query: "Postiz" });
    expect(matches).toEqual([expect.objectContaining({ threadId: "hosbah", title: "Hosbah", snippet: "install Postiz", environment: "windows" })]);
    expect(rpcCalls.at(-1)).toEqual({ tag: "orchestration.searchThreads", payload: { query: "Postiz", limit: 20 } });
  });

  it("maps send modes onto message.dispatch like t3_thread_send", async () => {
    await call("t3_send_message", { environment: "windows", threadId: "hosbah", prompt: "hi", mode: "queue", idempotencyKey: "k1" });
    expect(rpcCalls.at(-1)!.payload).toMatchObject({ type: "message.dispatch", threadId: "hosbah", text: "hi", dispatchMode: { type: "queue_after_active" } });
    expect(rpcCalls.at(-1)!.payload.deliveryIntent).toBeUndefined();

    await call("t3_send_message", { environment: "windows", threadId: "busy", prompt: "nudge", mode: "steer", idempotencyKey: "k2" });
    expect(rpcCalls.at(-1)!.payload).toMatchObject({ deliveryIntent: "steer", dispatchMode: { type: "start_immediately" } });

    await call("t3_send_message", { environment: "windows", threadId: "hosbah", prompt: "go" });
    expect(rpcCalls.at(-1)!.payload).toMatchObject({ deliveryIntent: "auto", dispatchMode: { type: "start_immediately" } });
  });

  it("refuses to steer an idle thread", async () => {
    const before = rpcCalls.length;
    const result = await call("t3_send_message", { environment: "windows", threadId: "hosbah", prompt: "x", mode: "steer" });
    expect(result.error).toMatch(/no active run to steer/);
    expect(rpcCalls.length).toBe(before);
  });

  it("names the environment and its pairing command when the token is rejected", async () => {
    const result = await call("t3_list_threads", { environment: "wrong-token" });
    expect(result.error).toMatch(/^\[environment "wrong-token"\] T3 rejected the stored token \(401\)/);
    expect(result.error).toContain("t3-agents-mcp pair --environment wrong-token --stdin");
  });

  it("reports an unreachable environment within its timeout", async () => {
    const started = Date.now();
    const result = await call("t3_list_threads", { environment: "down" });
    expect(result.error).toMatch(/"down" \(http:\/\/127\.0\.0\.1:9\) is unreachable/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("routes an entry or id naming this machine through the local connection", async () => {
    expect(await call("t3_list_threads", { environment: "self" })).toEqual([]);
    expect(await call("t3_list_threads", { environment: "mac-env" })).toEqual([]);
    const list = await call("t3_list_environments");
    expect(list.find((e: { name: string }) => e.name === "self")).toMatchObject({ local: true, aliasOf: "local", authorized: true });
  });

  it("lists the known names for an unknown environment", async () => {
    expect((await call("t3_list_threads", { environment: "nas" })).error).toMatch(/Unknown environment "nas"\. Known: local, windows/);
  });
});

