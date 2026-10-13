/**
 * Opt-in: drives the built MCP over stdio against a REAL configured remote
 * environment (point one at this machine's own T3 to test the remote path
 * locally). Read-only unless --send is given, which queues ONE short message
 * to the named thread; use a scratch thread, never someone's active session.
 *
 *   npx tsx test/environments.live.mts ENV_NAME [--title TEXT] [--read THREAD_ID] [--send THREAD_ID]
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [environment, ...rest] = process.argv.slice(2);
if (!environment) throw new Error('Usage: npx tsx test/environments.live.mts ENV_NAME [--title TEXT] [--read THREAD_ID] [--send THREAD_ID]');
const flag = (name: string) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };

const client = new Client({ name: 't3-agents-environments-live', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env: process.env as Record<string, string>, stderr: 'pipe' });
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 55000 });
  const body = (result.content as Array<{ text: string }>).map((c) => c.text).join('');
  if (result.isError) throw new Error(`${name}: ${body}`);
  return JSON.parse(body);
}

try {
  await client.connect(transport);
  const envs = await call('t3_list_environments');
  const target = envs.find((e: { name: string }) => e.name === environment);
  assert.ok(target, `environment ${environment} is not configured`);
  console.log('environment:', JSON.stringify({ name: target.name, url: target.url, environmentId: target.environmentId, label: target.label, serverVersion: target.serverVersion, authorized: target.authorized, projects: target.projects, threads: target.threads }));
  assert.equal(target.authorized, true, target.error);

  const threads = await call('t3_list_threads', { environment, limit: 5, ...(flag('--title') ? { titleContains: flag('--title') } : {}) });
  console.log('threads:', threads.map((t: { threadId: string; title: string; turn: { state: string } | null }) => `${t.threadId} ${JSON.stringify(t.title)} ${t.turn?.state ?? 'idle'}`));
  for (const t of threads) assert.equal(t.environment, environment);

  const readId = flag('--read');
  if (readId) {
    const thread = await call('t3_get_thread', { environment, threadId: readId, messageLimit: 2, maxChars: 300 });
    console.log('read:', JSON.stringify({ title: thread.title, state: thread.turn?.state, messages: thread.messages.map((m: { role: string; text: string }) => ({ role: m.role, text: m.text })) }, null, 2));
    assert.ok(thread.messages.length <= 2);
  }

  const sendId = flag('--send');
  if (sendId) {
    const key = `environments-live-${sendId}`;
    const sent = await call('t3_send_message', { environment, threadId: sendId, mode: 'queue', idempotencyKey: key, prompt: 'Cross-environment test from t3-agents-mcp. Reply with exactly: CROSS-ENV-OK. Do not use tools.' });
    console.log('send:', JSON.stringify({ reused: sent.reused, state: sent.turn?.state, url: sent.url }));
    const again = await call('t3_send_message', { environment, threadId: sendId, mode: 'queue', idempotencyKey: key, prompt: 'ignored on retry' });
    assert.equal(again.reused, true, 'a retry with the same key must not send twice');
  }
  console.log('OK');
} finally {
  await client.close();
}
