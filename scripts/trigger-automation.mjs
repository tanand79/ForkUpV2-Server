/**
 * Triggers the ForkUp automated Success Engine sweep.
 *
 * Intended to be invoked by any external scheduler (OS cron, Windows Task
 * Scheduler, an AWS EventBridge rule → Lambda/container, an Amplify scheduled
 * job, etc.) on a regular cadence (once daily is typical). It simply POSTs to
 * the secret-gated `/api/manage/automation/run-due` endpoint and reports the
 * result. It never sends emails itself — the server does, and only for actions
 * explicitly flagged to auto-send that are ready and due.
 *
 * Environment variables:
 *   AUTOMATION_API_URL  Base URL of the API (default: http://localhost:3001)
 *   AUTOMATION_SECRET   Shared secret; MUST match the server's AUTOMATION_SECRET
 *
 * Run: node scripts/trigger-automation.mjs
 * Exit code: 0 on success, 1 on any failure (so schedulers can alert).
 */

const API_BASE = (process.env.AUTOMATION_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const SECRET = process.env.AUTOMATION_SECRET ?? "";
const ENDPOINT = `${API_BASE}/api/manage/automation/run-due`;

async function main() {
  if (!SECRET) {
    console.error("[automation] AUTOMATION_SECRET is not set — refusing to call the endpoint.");
    process.exit(1);
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-automation-secret": SECRET,
      },
    });
  } catch (err) {
    console.error(`[automation] Request to ${ENDPOINT} failed:`, err?.message ?? err);
    process.exit(1);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 200) };
  }

  if (!res.ok) {
    console.error(`[automation] HTTP ${res.status}:`, JSON.stringify(json));
    process.exit(1);
  }

  const processed = json?.processed ?? 0;
  const totalSent = json?.totalSent ?? 0;
  console.log(
    `[automation] OK — processed ${processed} due action(s), sent ${totalSent} email(s).`,
  );
  process.exit(0);
}

main();
