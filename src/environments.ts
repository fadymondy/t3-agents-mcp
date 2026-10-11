import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { credentialsPath, loadCredential } from "./credentials.js";
import { probeEnvironment, type DiscoveredServer } from "./discovery.js";
import { makeHttpClient } from "./http.js";
import { PAIR_HINT, T3RpcClient } from "./rpc.js";
import { T3Api, type T3Connection } from "./t3.js";
import type { Environments, ToolContext } from "./tools.js";

/**
 * Named T3 environments other than the local one, e.g. a Windows desktop on
 * the same tailnet. Each entry is reached over T3's own HTTP + WebSocket API
 * with a bearer token. Tokens never live in this file: an entry only says
 * where to find one.
 */
const AuthSchema = z.discriminatedUnion("type", [
  /** Token stored by `t3-agents-mcp pair --environment <name>` (credentials.json, keyed by url). */
  z.object({ type: z.literal("paired") }),
  /** Token read from an environment variable of the MCP process. */
  z.object({ type: z.literal("env"), var: z.string().min(1) }),
  /** Token read from the macOS keychain (`security find-generic-password -w`). */
  z.object({ type: z.literal("keychain"), service: z.string().min(1), account: z.string().min(1) }),
  /** Token printed on stdout by a command (argv, no shell), e.g. a vault CLI. */
  z.object({ type: z.literal("command"), command: z.array(z.string()).min(1) }),
]);

const EnvironmentSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, "use letters, digits, '-' or '_'")
    .refine((name) => name.toLowerCase() !== "local", '"local" is reserved for this machine'),
  url: z.string().url(),
  /** Expected T3 environment id. A server answering with another id is refused before any token is sent. */
  environmentId: z.string().optional(),
  description: z.string().optional(),
  auth: AuthSchema.default({ type: "paired" }),
  /** Probe and token-command timeout. Default 8000. */
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
});

const FileSchema = z.object({
  version: z.literal(1).default(1),
  environments: z.array(EnvironmentSchema).default([]),
});

export type EnvironmentAuth = z.infer<typeof AuthSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;

export const LOCAL_ENVIRONMENT = "local";
const DEFAULT_TIMEOUT_MS = 8000;

export function environmentsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.T3_MCP_ENVIRONMENTS?.trim() || join(home, ".config", "t3-agents-mcp", "environments.json");
}

/** Read the config. A missing file is an empty list; an invalid one is an error naming the problem. */
export async function loadEnvironments(path: string): Promise<EnvironmentConfig[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${path}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.environments) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new Error(`${path}: environment "${entry.name}" is defined twice.`);
    seen.add(key);
  }
  return parsed.data.environments.map((e) => ({ ...e, url: new URL(e.url).origin }));
}

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      // stderr is deliberately dropped: a vault CLI may echo what it was asked for.
      if (error) reject(new Error(error.killed ? `timed out after ${timeoutMs}ms` : `exited with ${error.code ?? "an error"}`));
      else resolve(stdout);
    });
  });

/** Resolve an entry's bearer token. Errors name the source, never the value. */
export async function resolveEnvironmentToken(
  entry: EnvironmentConfig,
  options: { env?: NodeJS.ProcessEnv; run?: CommandRunner; platform?: NodeJS.Platform } = {},
): Promise<{ token: string; source: string }> {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = entry.auth;
  const fromCommand = async (command: string, args: string[], source: string) => {
    let output: string;
    try {
      output = await run(command, args, timeoutMs);
    } catch (error) {
      throw new Error(`Environment "${entry.name}": token ${source} failed (${(error as Error).message}).`);
    }
    const token = output.trim();
    if (!token) throw new Error(`Environment "${entry.name}": token ${source} printed nothing.`);
    return { token, source };
  };
  switch (auth.type) {
    case "env": {
      const token = env[auth.var]?.trim();
      if (!token) throw new Error(`Environment "${entry.name}": environment variable ${auth.var} is not set.`);
      return { token, source: `env ${auth.var}` };
    }
    case "keychain": {
      if ((options.platform ?? process.platform) !== "darwin") {
        throw new Error(`Environment "${entry.name}": keychain auth is macOS-only; use "command" or "env" here.`);
      }
      return fromCommand("security", ["find-generic-password", "-s", auth.service, "-a", auth.account, "-w"], `keychain ${auth.service}/${auth.account}`);
    }
    case "command":
      return fromCommand(auth.command[0]!, auth.command.slice(1), `command ${auth.command[0]}`);
    case "paired": {
      const path = credentialsPath(env);
      const stored = await loadCredential(path, entry.url);
      if (!stored) {
        throw new Error(`Environment "${entry.name}" is not paired. ${pairHint(entry.name)}`);
      }
      if (new Date(stored.expiresAt).getTime() < Date.now()) {
        throw new Error(`Environment "${entry.name}": the paired token expired on ${stored.expiresAt}. ${pairHint(entry.name)}`);
      }
      return { token: stored.accessToken, source: path };
    }
  }
}

export const pairHint = (name: string) =>
  `On ${name}, open T3 Settings > Connections > Create pairing link, then run here: t3-agents-mcp pair --environment ${name} --stdin`;

/** Probe an environment and refuse one that is down or not the server the config names. */
export async function probeConfigured(
  entry: EnvironmentConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredServer> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe = await probeEnvironment(entry.url, fetchImpl, timeoutMs);
  if (!probe) {
    throw new Error(
      `Environment "${entry.name}" (${entry.url}) is unreachable: no T3 server answered within ${timeoutMs}ms. Check that T3 is running there with network access enabled and that Tailscale is connected.`,
    );
  }
  if (entry.environmentId && probe.environmentId !== entry.environmentId) {
    throw new Error(
      `Environment "${entry.name}" (${entry.url}) answered as environment ${probe.environmentId}, not ${entry.environmentId}. Refusing to send a token to it; fix the url or environmentId in the config.`,
    );
  }
  return { origin: entry.url, runtimeFile: "(environments.json)", pid: -1, ...probe };
}

export interface EnvironmentStatus {
  name: string;
  url: string;
  description?: string;
  local: boolean;
  reachable: boolean;
  environmentId?: string;
  label?: string;
  serverVersion?: string;
  authorized?: boolean;
  tokenSource?: string;
  projects?: number;
  threads?: number;
  error?: string;
}

export interface RegistryOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  run?: CommandRunner;
  /** Builds the connection; tests swap in a fake. */
  makeConnection?: (server: DiscoveredServer, token: string, tokenSource: string) => T3Connection;
}

const defaultConnection = (server: DiscoveredServer, token: string, tokenSource: string): T3Connection => ({
  server,
  tokenSource,
  http: makeHttpClient(server.origin, token),
  rpc: new T3RpcClient(server.origin, token),
});

/**
 * Reads the config on every lookup, so a newly added environment needs no
 * restart, and keeps one connection per environment. A connection is dropped
 * when its config entry changes or a call through it fails, so re-pairing or
 * a restarted remote takes effect on the next call.
 */
export class EnvironmentRegistry {
  private readonly connections = new Map<string, { key: string; conn: Promise<T3Connection> }>();

  constructor(
    readonly path: string,
    private readonly options: RegistryOptions = {},
  ) {}

  list(): Promise<EnvironmentConfig[]> {
    return loadEnvironments(this.path);
  }

  async find(nameOrId: string): Promise<EnvironmentConfig> {
    const entries = await this.list();
    const wanted = nameOrId.trim().toLowerCase();
    const entry = entries.find((e) => e.name.toLowerCase() === wanted || e.environmentId?.toLowerCase() === wanted);
    if (!entry) {
      const known = entries.map((e) => e.name);
      throw new Error(
        `Unknown environment "${nameOrId}". Known: ${[LOCAL_ENVIRONMENT, ...known].join(", ")}. Add it to ${this.path}.`,
      );
    }
    return entry;
  }

  async connect(nameOrId: string): Promise<{ entry: EnvironmentConfig; conn: T3Connection }> {
    const entry = await this.find(nameOrId);
    const key = JSON.stringify(entry);
    const cached = this.connections.get(entry.name);
    if (cached && cached.key === key) return { entry, conn: await cached.conn };
    if (cached) void cached.conn.then((c) => c.rpc.close(), () => undefined);
    const conn = (async () => {
      const server = await probeConfigured(entry, this.options.fetchImpl);
      const { token, source } = await resolveEnvironmentToken(entry, { env: this.options.env, run: this.options.run });
      return (this.options.makeConnection ?? defaultConnection)(server, token, source);
    })();
    this.connections.set(entry.name, { key, conn });
    try {
      return { entry, conn: await conn };
    } catch (error) {
      this.evict(entry.name);
      throw error;
    }
  }

  evict(name: string): void {
    const cached = this.connections.get(name);
    if (!cached) return;
    this.connections.delete(name);
    void cached.conn.then((c) => c.rpc.close(), () => undefined);
  }

  close(): void {
    for (const name of Array.from(this.connections.keys())) this.evict(name);
  }
}

/** Expose a registry to the MCP tools. */
export function toolEnvironments(registry: EnvironmentRegistry): Environments {
  const resolve = async (nameOrId: string): Promise<ToolContext> => {
    const { entry, conn } = await registry.connect(nameOrId);
    return { api: new T3Api(conn), origin: conn.server.origin, environmentId: conn.server.environmentId, environment: entry.name };
  };
  return {
    resolve,
    evict: (nameOrId) => {
      void registry.find(nameOrId).then((entry) => registry.evict(entry.name), () => undefined);
    },
    statuses: async (verify) => {
      const entries = await registry.list();
      return Promise.all(
        entries.map(async (entry): Promise<EnvironmentStatus> => {
          const status: EnvironmentStatus = {
            name: entry.name,
            url: entry.url,
            ...(entry.description ? { description: entry.description } : {}),
            local: false,
            reachable: false,
          };
          let ctx: ToolContext;
          try {
            ctx = await resolve(entry.name);
          } catch (error) {
            const message = (error as Error).message;
            // Reaching the token step means the probe succeeded.
            status.reachable = !/unreachable|answered as environment/.test(message);
            if (status.reachable) status.authorized = false;
            status.error = message;
            return status;
          }
          const { conn } = await registry.connect(entry.name);
          Object.assign(status, {
            reachable: true,
            environmentId: conn.server.environmentId,
            label: conn.server.label,
            serverVersion: conn.server.serverVersion,
            tokenSource: conn.tokenSource,
          });
          if (!verify) return status;
          try {
            const shell = await ctx.api.shell();
            Object.assign(status, { authorized: true, projects: shell.projects.length, threads: shell.threads.length });
          } catch (error) {
            registry.evict(entry.name);
            status.authorized = false;
            status.error = (error as Error).message.replace(PAIR_HINT, pairHint(entry.name));
          }
          return status;
        }),
      );
    },
  };
}
