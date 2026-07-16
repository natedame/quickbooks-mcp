// E2E verification for scripts/plaid-embed-connect.mjs — 6 varied scenarios.
// Run from the repo root: cd ~/local-projects/quickbooks-mcp && node scripts/plaid-embed-connect-e2e.mjs
import { spawn } from "child_process";
import { existsSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const REPO = process.cwd();
const SCRIPT = "scripts/plaid-embed-connect.mjs";
const SANDBOX_ITEM = join(homedir(), ".quickbooks-mcp", "plaid-item.sandbox.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra = "") { (cond ? (pass++, console.log(`  ✅ ${name}`)) : (fail++, console.log(`  ❌ ${name} ${extra}`))); }

// Spawn the server, resolve once READY (with the port + captured stdout ref), or on early exit.
function startServer({ port, env, extraEnv = {} }) {
  const child = spawn("node", [SCRIPT, "--port", String(port), "--watch-seconds", "45"],
    { cwd: REPO, env: { ...process.env, PLAID_ENV: env, ...extraEnv } });
  const out = { text: "", code: null, child };
  child.stdout.on("data", (d) => (out.text += d));
  child.stderr.on("data", (d) => (out.text += d));
  child.on("exit", (c) => (out.code = c));
  return out;
}
async function waitFor(out, needle, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (out.text.includes(needle) || out.code !== null) return; await sleep(150); }
}
function nonceFrom(html) { const m = html.match(/nonce:'([0-9a-f]+)'/); return m && m[1]; }

console.log("\n=== Scenario 1: PRODUCTION — mints a real embedded link_token + serves the page ===");
{
  rmSync(SANDBOX_ITEM, { force: true });
  const s = startServer({ port: 8793, env: "production" });
  await waitFor(s, "CONNECT PAGE READY");
  check("server came up (no early exit)", s.code === null, `(exit=${s.code}) ${s.text.slice(-200)}`);
  let html = "";
  try { html = await (await fetch("http://127.0.0.1:8793/")).text(); } catch (e) { html = `FETCH_ERR ${e}`; }
  check("page loads Plaid Link JS from cdn.plaid.com", html.includes("cdn.plaid.com/link/v2/stable/link-initialize.js"));
  check("page carries a REAL production link_token", /token:\s*"link-production-/.test(html), `(no prod token in page)`);
  check("page embeds a session nonce", !!nonceFrom(html));
  check("page auto-opens Link (handler.open())", html.includes("handler.open()"));
  // Scenario 2: nonce enforcement on this live server
  console.log("\n=== Scenario 2: nonce enforcement (wrong nonce rejected) ===");
  const cap = await fetch("http://127.0.0.1:8793/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_token: "x", nonce: "WRONG" }) });
  check("POST /capture with bad nonce -> 403", cap.status === 403, `(got ${cap.status})`);
  const ex = await fetch("http://127.0.0.1:8793/exit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error_code: "x", nonce: "WRONG" }) });
  check("POST /exit with bad nonce -> 403", ex.status === 403, `(got ${ex.status})`);
  // Scenario 3: exit diagnostic logging (correct nonce)
  console.log("\n=== Scenario 3: onExit diagnostic is logged (the whole point) ===");
  const n = nonceFrom(html);
  await fetch("http://127.0.0.1:8793/exit", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: n, error_code: "INSTITUTION_NOT_RESPONDING", error_type: "INSTITUTION_ERROR", status: "requires_credentials", display_message: "The bank is not responding.", request_id: "req-123" }) });
  await sleep(400);
  check("server logs the exact onExit error_code", s.text.includes("PLAID ONEXIT") && s.text.includes("INSTITUTION_NOT_RESPONDING"), s.text.slice(-260));
  check("server stays up after a non-fatal exit (Nate can retry)", s.code === null);
  s.child.kill("SIGTERM"); await sleep(300);
}

console.log("\n=== Scenario 4: idempotency guard — refuses to clobber an existing Item ===");
{
  // Seed a sandbox item so loadItem() finds one.
  const { writeFileSync } = await import("fs");
  writeFileSync(SANDBOX_ITEM, JSON.stringify({ env: "sandbox", access_token: "a", item_id: "it-1", institution_name: "Test Bank", created_at: "x", updated_at: "x" }), { mode: 0o600 });
  const s = startServer({ port: 8795, env: "sandbox" });
  await waitFor(s, "ALREADY_CONNECTED");
  await sleep(300);
  check("exits 3 ALREADY_CONNECTED when an Item exists", s.code === 3, `(exit=${s.code}) ${s.text.slice(-200)}`);
  rmSync(SANDBOX_ITEM, { force: true });
}

console.log("\n=== Scenario 5: single-instance lock ===");
{
  const s1 = startServer({ port: 8796, env: "sandbox" });
  await waitFor(s1, "CONNECT PAGE READY");
  const s2 = startServer({ port: 8797, env: "sandbox" });
  await waitFor(s2, "LOCKED");
  await sleep(300);
  check("second instance exits 5 LOCKED", s2.code === 5, `(exit=${s2.code}) ${s2.text.slice(-160)}`);
  s1.child.kill("SIGTERM"); await sleep(300);
}

console.log("\n=== Scenario 6: SANDBOX full capture (onSuccess -> exchange -> saveItem -> exit 0) ===");
{
  rmSync(SANDBOX_ITEM, { force: true });
  const s = startServer({ port: 8798, env: "sandbox" });
  await waitFor(s, "CONNECT PAGE READY");
  const html = await (await fetch("http://127.0.0.1:8798/")).text();
  const n = nonceFrom(html);
  // Mint a real sandbox public_token (no bank UI) and drive the capture endpoint exactly as onSuccess would.
  process.env.PLAID_ENV = "sandbox";
  const { PlaidClient } = await import(join(REPO, "dist/plaid/client.js"));
  const sandbox = new PlaidClient(undefined, "sandbox");
  const publicToken = await sandbox.createSandboxPublicToken();
  const r = await fetch("http://127.0.0.1:8798/capture", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: n, public_token: publicToken, institution_id: "ins_109508", institution_name: "First Platypus Bank" }) });
  check("POST /capture with valid nonce -> 200", r.status === 200, `(got ${r.status})`);
  await waitFor(s, "CAPTURED", 12000); await sleep(600);
  check("server exchanged + logged CAPTURED", s.text.includes("✅ CAPTURED"), s.text.slice(-300));
  check("durable Item persisted to disk", existsSync(SANDBOX_ITEM));
  check("masked account read-back from the live feed", /Read \d+ account/.test(s.text));
  check("server exits 0 after capture", s.code === 0, `(exit=${s.code})`);
  rmSync(SANDBOX_ITEM, { force: true });
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
