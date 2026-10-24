import { discoverServer, type DiscoveredServer } from "./discovery.js";
import { resolveAccessToken } from "./credentials.js";
import { makeHttpClient, type HttpClient } from "./http.js";
import { T3RpcClient } from "./rpc.js";
import { normalizeShell, normalizeDetail } from "./v2.js";
import { assertThreadShape, type DispatchResult, type InteractionMode, type ModelSelection, type RuntimeMode, type ServerConfig, type ShellSnapshot, type ThreadDetailSnapshot, type VcsListRefsResult, } from "./types.js";
export interface T3Connection {
    server: DiscoveredServer;
    tokenSource: string;
    http: HttpClient;
    rpc: Pick<T3RpcClient, "call" | "stream" | "close">;
}
export async function connect(env: NodeJS.ProcessEnv = process.env): Promise<T3Connection> {
    const server = await discoverServer({ env });
    const { token, source } = await resolveAccessToken(server.origin, env);
    return {
        server,
        tokenSource: source,
        http: makeHttpClient(server.origin, token),
        rpc: new T3RpcClient(server.origin, token),
    };
}
export interface ThreadCreateSpec {
    commandId: string;
    threadId: string;
    messageId: string;
    projectId: string;
    title: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
    branch: string | null;
    worktreePath: string | null;
    text: string;
    newWorktree?: {
        projectCwd: string;
        baseBranch: string;
        branch?: string;
        runSetupScript: boolean;
    };
}
export interface TurnStartSpec {
    commandId: string;
    threadId: string;
    messageId: string;
    text: string;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
    /** Delivery while a run is active; same meaning as T3's own `t3_thread_send`. Default auto. */
    mode?: DeliveryMode;
    /** The model for this one turn (`message.dispatch.modelSelection`); omitted = the thread's model. */
    modelSelection?: ModelSelection;
}
export type DeliveryMode = "auto" | "queue" | "steer" | "restart";
export interface ThreadSearchMatch {
    threadId: string;
    projectId: string;
    source: "user" | "assistant";
    snippet: string;
    messageCreatedAt: string | null;
}
export interface WaitOptions {
    /** Only a turn that carries this user message counts as "the turn we are waiting for". */
    expectedMessageId?: string;
}
/** Events after which the thread projection may have moved to a settled state. */
/**
 * Typed wrappers over T3's surfaces. Reads go over HTTP snapshots. Commands go
 * over the RPC socket, not `POST /api/orchestration/dispatch`: only the socket
 * handler expands `bootstrap` (create thread + prepare worktree) before
 * applying the turn, and it returns typed errors instead of a generic 500.
 */
export class T3Api {
    constructor(private readonly conn: T3Connection) { }
    async shell(): Promise<ShellSnapshot> {
        return normalizeShell(await this.conn.http.get("/api/orchestration/shell"));
    }
    async thread(threadId: string, _turnLimit?: number, expectedMessageId?: string): Promise<ThreadDetailSnapshot> {
        const snapshot = await this.conn.http.get<ThreadDetailSnapshot & {
            projection?: unknown;
        }>(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
        return snapshot.projection ? normalizeDetail(snapshot, expectedMessageId) : assertThreadShape(snapshot);
    }
    config(): Promise<ServerConfig> {
        return this.conn.rpc.call<ServerConfig>("server.getConfig", {});
    }
    /** All local refs for a checkout. T3 pages at 200, so follow `nextCursor` until it is null. */
    async listRefs(cwd: string): Promise<VcsListRefsResult> {
        const refs: VcsListRefsResult["refs"] = [];
        let cursor: number | undefined;
        let last: VcsListRefsResult | undefined;
        for (let page = 0; page < 50; page++) {
            last = await this.conn.rpc.call<VcsListRefsResult>("vcs.listRefs", {
                cwd,
                refKind: "local",
                refresh: page === 0,
                limit: 200,
                ...(cursor === undefined ? {} : { cursor }),
            });
            refs.push(...last.refs);
            if (last.nextCursor === null || last.nextCursor === undefined)
                break;
            cursor = last.nextCursor;
        }
        return { ...(last as VcsListRefsResult), refs, nextCursor: null };
    }
    /** Full-text search over thread messages in every project (T3 caps the limit at 50). */
    async searchThreads(query: string, limit?: number): Promise<ThreadSearchMatch[]> {
        const result = await this.conn.rpc.call<{ matches: ThreadSearchMatch[] }>("orchestration.searchThreads", { query, ...(limit === undefined ? {} : { limit }) });
        return result.matches;
    }
    dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
        return this.conn.rpc.call<DispatchResult>("orchestration.dispatchCommand", command);
    }
    /** V2 launch owns workspace preparation and persists the caller's IDs. */
    async createThreadWithFirstTurn(spec: ThreadCreateSpec): Promise<unknown> {
        if (spec.newWorktree?.runSetupScript === false) {
            throw new Error('V2 launch cannot disable project setup scripts. Use an existing isolated worktree instead.');
        }
        return this.conn.rpc.call('orchestration.launchThread', {
            commandId: spec.commandId, threadId: spec.threadId, creationSource: 'mcp',
            projectId: spec.projectId, title: spec.title, generateTitle: false,
            modelSelection: spec.modelSelection, runtimeMode: spec.runtimeMode,
            interactionMode: spec.interactionMode,
            workspaceStrategy: spec.newWorktree
                ? { type: 'worktree', baseRef: spec.newWorktree.baseBranch, ...(spec.newWorktree.branch ? { branch: spec.newWorktree.branch } : {}) }
                : spec.worktreePath ? { type: 'existing_worktree', worktreePath: spec.worktreePath, ...(spec.branch ? { branch: spec.branch } : {}) }
                    : { type: 'root', ...(spec.branch ? { branch: spec.branch } : {}) },
            initialMessage: { messageId: spec.messageId, text: spec.text, attachments: [] },
        });
    }
    async startTurn(spec: TurnStartSpec): Promise<DispatchResult> {
        const before = await this.thread(spec.threadId);
        const mode = spec.mode ?? 'auto';
        if ((mode === 'steer' || mode === 'restart') && before.thread.latestTurn?.state !== 'running') {
            throw new Error(`Thread ${spec.threadId} has no active run to ${mode}. Use mode "auto" or "queue".`);
        }
        // Mode changes are explicit commands in V2, never silently discarded.
        if (before.thread.runtimeMode !== spec.runtimeMode) {
            await this.dispatch({ type: 'thread.runtime-mode.set', commandId: spec.commandId + ':runtime', threadId: spec.threadId, runtimeMode: spec.runtimeMode });
        }
        if (before.thread.interactionMode !== spec.interactionMode) {
            await this.dispatch({ type: 'thread.interaction-mode.set', commandId: spec.commandId + ':interaction', threadId: spec.threadId, interactionMode: spec.interactionMode });
        }
        return this.dispatch({
            type: 'message.dispatch', commandId: spec.commandId, threadId: spec.threadId,
            messageId: spec.messageId, text: spec.text, attachments: [], createdBy: 'agent', creationSource: 'mcp',
            ...(spec.modelSelection ? { modelSelection: spec.modelSelection } : {}),
            // The server resolves an intent against its serialized thread state, so
            // a run that ends between our read and the dispatch cannot misroute it.
            ...(mode === 'queue'
                ? { dispatchMode: { type: 'queue_after_active' } }
                : { deliveryIntent: mode, dispatchMode: { type: 'start_immediately' } }),
        });
    }
    interruptTurn(commandId: string, threadId: string, turnId?: string): Promise<DispatchResult> {
        if (!turnId)
            throw new Error('V2 interruption requires an explicit run ID.');
        return this.dispatch({ type: 'run.interrupt', commandId, threadId, runId: turnId });
    }
    /**
     * Wait until the thread's latest turn stops running. One subscription stays
     * open for the whole wait; on events that can mean "settled" the HTTP
     * snapshot is re-read (it lags the event by a tick, so a few bounded
     * re-reads). Resolves with the final snapshot either way; `timedOut` says
     * which. With `expectedMessageId`, only the turn that carries that user
     * message counts, which makes waiting after a dispatch immune to projection
     * lag and to the previous turn still being "latest".
     */
    async waitForTurnSettled(threadId: string, timeoutMs: number, options: WaitOptions = {}): Promise<{
        snapshot: ThreadDetailSnapshot;
        timedOut: boolean;
    }> {
        const deadline = Date.now() + timeoutMs;
        const read = () => this.thread(threadId, 1, options.expectedMessageId);
        let snapshot = await read();
        if (isSettled(snapshot, options))
            return { snapshot, timedOut: false };
        while (Date.now() < deadline) {
            let hint = false;
            await this.conn.rpc.stream("orchestration.subscribeThread", { threadId, afterSequence: snapshot.snapshotSequence }, (item) => {
                const record = item as {
                    kind?: string;
                    event?: {
                        type?: string;
                    };
                };
                if (record.kind !== "snapshot" && record.kind !== "event")
                    return false;
                hint = true;
                return true;
            }, Math.min(2000, Math.max(0, deadline - Date.now())));
            // Periodic reads also recover when notifications are missed or T3 reconnects.
            for (let attempt = 0; attempt < 4; attempt++) {
                snapshot = await read();
                if (isSettled(snapshot, options))
                    return { snapshot, timedOut: false };
                await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            }
        }
        return { snapshot: await read(), timedOut: true };
    }
}
export function isSettled(snapshot: ThreadDetailSnapshot, options: WaitOptions = {}): boolean {
    const turn = snapshot.thread.latestTurn;
    if (!turn)
        return false;
    if (options.expectedMessageId) {
        const ownMessage = snapshot.thread.messages.find((m) => m.id === options.expectedMessageId);
        if (!ownMessage)
            return false;
        // The user message is committed before the turn starts; until the turn
        // exists the previous, already-settled turn is still "latest".
        if (ownMessage.turnId && ownMessage.turnId !== turn.turnId)
            return false;
        if (!ownMessage.turnId && !isNewerThan(turn, ownMessage.createdAt))
            return false;
    }
    if (turn.state === "running")
        return false;
    const assistant = turn.assistantMessageId
        ? snapshot.thread.messages.find((m) => m.id === turn.assistantMessageId)
        : undefined;
    return !(assistant?.streaming ?? false);
}
const isNewerThan = (turn: {
    startedAt: string | null;
}, iso: string): boolean => turn.startedAt !== null && turn.startedAt >= iso;
