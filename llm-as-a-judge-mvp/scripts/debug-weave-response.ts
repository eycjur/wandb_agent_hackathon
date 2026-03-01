/**
 * Weave Trace API の生レスポンスを確認する診断スクリプト
 * npx tsx scripts/debug-weave-response.ts で実行
 */
// Load .env manually
import { readFileSync } from "fs";
import { resolve } from "path";
try {
  const envPath = resolve(process.cwd(), ".env");
  const env = readFileSync(envPath, "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const TRACE_API_BASE = "https://trace.wandb.ai";

async function main() {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) {
    console.error("WANDB_API_KEY not set");
    process.exit(1);
  }

  const projectId = process.env.WANDB_ENTITY
    ? `${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT ?? "resume-assistant"}`
    : null;
  if (!projectId) {
    console.error("WANDB_ENTITY or projectId required");
    process.exit(1);
  }

  const body = {
    project_id: projectId,
    filter: { trace_roots_only: true },
    limit: 5,
    offset: 0,
    sort_by: [{ field: "started_at", direction: "desc" }],
    include_feedback: false
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  const res = await fetch(`${TRACE_API_BASE}/calls/stream_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`
    },
    body: JSON.stringify(body)
  });

  console.log("Status:", res.status);
  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);
  console.log("Lines count:", lines.length);

  for (let i = 0; i < Math.min(2, lines.length); i++) {
    const call = JSON.parse(lines[i]);
    console.log("\n--- Call", i + 1, "---");
    console.log("Keys:", Object.keys(call));
    console.log("op_name:", call.op_name);
    console.log("inputs keys:", call.inputs ? Object.keys(call.inputs) : "none");
    if (call.inputs) {
      console.log("inputs sample:", JSON.stringify(call.inputs, null, 2).slice(0, 500));
    }
  }
}

main().catch(console.error);
