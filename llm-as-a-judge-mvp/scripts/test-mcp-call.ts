/**
 * W&B MCP 呼び出し検証スクリプト
 *
 * 使い方:
 *   npx tsx scripts/test-mcp-call.ts pythonista/resume-assistant self_pr
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateTextWithWandbMcp } from "../lib/infrastructure/gemini/geminiMcpGenerator";

function loadEnvFile(path: string): void {
  try {
    const env = readFileSync(path, "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (process.env[key] == null || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore missing env files
  }
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env"));
  loadEnvFile(resolve(process.cwd(), ".env.local"));

  const projectId = process.argv[2] ?? "pythonista/resume-assistant";
  const domain = process.argv[3] ?? "self_pr";

  const prompt = `あなたはデータ取得検証アシスタントです。
W&B MCP ツールだけを使って、以下の条件でトレースを探索してください。

project: ${projectId}
domain: ${domain}

手順:
1. domain="${domain}" で traces を取得する。op_name は厳密一致しない。
2. 0件なら op_name 条件を外して再取得する。
3. 次を JSON で返す:
{
  "project": "...",
  "domain": "...",
  "count": number,
  "ops": string[],
  "note": "..."
}

必ず実データに基づいて回答し、推測しない。`;

  console.log("[test-mcp-call] start", { projectId, domain });
  const text = await generateTextWithWandbMcp(prompt);
  console.log("[test-mcp-call] response:");
  console.log(text);
}

main().catch((error) => {
  console.error("[test-mcp-call] failed:", error);
  process.exit(1);
});

