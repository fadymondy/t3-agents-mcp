import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("pairs through stdin across platforms without printing secrets, including paths with spaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3 mcp cli "));
  const credentialPath = join(dir, "private store", "credentials.json");
  const pairingCode = "fake-pairing-code-for-test";
  const token = "fake-bearer-token-for-test";
  let receivedCode: string | null = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    receivedCode = new URLSearchParams(body).get("subject_token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 60, scope: "test" }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    // Run source through Node's tsx loader so npm test also works before a build.
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "pair", "--stdin"], {
      env: { ...process.env, T3_MCP_CREDENTIALS: credentialPath },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const completion = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(`${origin}/pair#token=${pairingCode}\n`);
    expect(await completion).toBe(0);
    expect(receivedCode).toBe(pairingCode);
    expect(output).toContain("Paired with");
    expect(output).not.toContain(pairingCode);
    expect(output).not.toContain(token);
    const store = JSON.parse(await readFile(credentialPath, "utf8"));
    expect(store.credentials[0].accessToken).toBe(token);
    expect(store.credentials[0].origin).toBe(origin);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
