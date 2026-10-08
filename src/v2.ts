import { z } from 'zod';
import type { ShellSnapshot, ThreadShell, ThreadDetailSnapshot, Message, LatestTurn } from './types.js';
const status = z.enum(['idle', 'preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const base = z.object({
    id: z.string(), projectId: z.string(), title: z.string(),
    modelSelection: z.object({ instanceId: z.string(), model: z.string() }).passthrough(),
    runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
    interactionMode: z.enum(['default', 'plan']), branch: z.string().nullable(), worktreePath: z.string().nullable(),
    updatedAt: z.string(), archivedAt: z.string().nullable(),
}).passthrough();
const runSchema = z.object({ id: z.string(), ordinal: z.number(), status, userMessageId: z.string(), requestedAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string().nullable() }).passthrough();
const messageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant', 'system']), text: z.string(), runId: z.string().nullable(), streaming: z.boolean(), createdAt: z.string() }).passthrough();
export const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
function state(value: string): string { return activeStatuses.has(value) ? 'running' : value === 'failed' ? 'error' : value; }
function shellThread(value: unknown): ThreadShell {
    const t = base.extend({ status, latestRunId: z.string().nullable(), activeRunId: z.string().nullable(), latestRunStartedAt: z.string().nullable().optional(), latestRunCompletedAt: z.string().nullable().optional(), lastError: z.string().nullable().optional() }).parse(value);
    const id = t.activeRunId ?? t.latestRunId;
    return { ...t, latestTurn: id ? { turnId: id, state: state(t.status), startedAt: t.latestRunStartedAt ?? null, completedAt: t.latestRunCompletedAt ?? null, assistantMessageId: null } : null, session: { status: t.status, lastError: t.lastError ?? null }, hasPendingApprovals: t.status === 'waiting', hasPendingUserInput: t.status === 'waiting', hasActionableProposedPlan: t.hasActionableProposedPlan === true };
}
export function normalizeShell(value: unknown): ShellSnapshot {
    const s = z.object({ snapshotSequence: z.number(), projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string(), defaultModelSelection: z.object({ instanceId: z.string(), model: z.string() }).passthrough().nullable() }).passthrough()), threads: z.array(z.unknown()), archivedThreads: z.array(z.unknown()).optional() }).parse(value);
    return { ...s, threads: [...s.threads, ...(s.archivedThreads ?? [])].map(shellThread) };
}
export function normalizeDetail(value: unknown, expectedMessageId?: string): ThreadDetailSnapshot {
    const s = z.object({ snapshotSequence: z.number(), hasMoreHistory: z.boolean().optional(), projection: z.object({ thread: base, runs: z.array(runSchema), messages: z.array(messageSchema), runtimeRequests: z.array(z.unknown()).optional() }).passthrough() }).parse(value);
    if (s.hasMoreHistory)
        throw new Error('T3 returned incomplete history. Full projection is required for safe message retries.');
    const p = s.projection;
    const ordered = [...p.runs].sort((a, b) => a.ordinal - b.ordinal);
    const messages: Message[] = p.messages.map(m => ({ ...m, turnId: m.runId }));
    const own = expectedMessageId ? messages.find(m => m.id === expectedMessageId) : undefined;
    const run = own?.turnId ? ordered.find(r => r.id === own.turnId) : [...ordered].reverse().find(r => activeStatuses.has(r.status)) ?? ordered.at(-1);
    const assistant = run ? [...messages].reverse().find(m => m.role === 'assistant' && m.turnId === run.id) : undefined;
    const latestTurn: LatestTurn | null = run ? { turnId: run.id, state: state(run.status), startedAt: run.startedAt ?? run.requestedAt, completedAt: run.completedAt, assistantMessageId: assistant?.id ?? null } : null;
    return { snapshotSequence: s.snapshotSequence, thread: { ...p.thread, latestTurn, session: { status: run?.status ?? 'idle', lastError: null }, messages } };
}
