/**
 * W&B MCP 呼び出し検証スクリプト（Node実行）
 *
 * 使い方:
 *   node scripts/test-mcp-call.mjs pythonista/resume-assistant self_pr
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleGenAI, mcpToTool } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = "https://mcp.withwandb.com/mcp";
const MODEL = "gemini-2.5-pro";
const MCP_TIMEOUT_MS = 120_000;

function loadEnvFile(path) {
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
    // ignore
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env"));
  loadEnvFile(resolve(process.cwd(), ".env.local"));

  const projectId = process.argv[2] ?? "pythonista/resume-assistant";
  const domain = process.argv[3] ?? "self_pr";
  const geminiApiKey = requireEnv("GEMINI_API_KEY");
  const wandbApiKey = requireEnv("WANDB_API_KEY");

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${wandbApiKey}` }
    }
  });
  const mcpClient = new Client({ name: "mcp-debug", version: "1.0.0" });

  const prompt = `あなたはデータ取得検証アシスタントです。
W&B MCP ツールだけを使って、以下の条件でトレースを探索してください。

project: ${projectId}
domain: ${domain}

手順:
1. まず op_name が "judge_log" / "generate_log" / "human_feedback_log" に関連する最新トレースを取得する（domain 条件は最初に固定しない）。
2. 取得データを見て、domain が "inputs.arg0.domain" / "inputs.domain" / "attributes.domain" のどこに入っているか特定する。
3. 手順2で特定したキーを使い domain="${domain}" の件数を数える。
4. 最後に JSON で返す:
{
  "project": "...",
  "domain": "...",
  "count": number,
  "ops": string[],
  "domainKeyDetected": "inputs.arg0.domain | inputs.domain | attributes.domain | none",
  "note": "..."
}

必ず実データに基づいて回答し、推測しない。`;

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), MCP_TIMEOUT_MS);
  });

  console.log("[test-mcp-call] connecting...");
  try {
    await Promise.race([mcpClient.connect(transport), timeoutPromise]);
    console.log("[test-mcp-call] connected");

    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          temperature: 0.3,
          tools: [mcpToTool(mcpClient)],
          systemInstruction: [
            "# MCP",
            "あなたは W&B Weave のデータにアクセスできる MCP ツールを持っています。",
            "不足情報は MCP ツール（query_weave_traces_tool など）で取得してください。",
            "ツールを呼び出さずに推測することは禁止です。"
          ].join("\n")
        }
      }),
      timeoutPromise
    ]);

    const history = response.automaticFunctionCallingHistory ?? [];
    const toolParts = history
      .flatMap((c) => c.parts ?? [])
      .filter((p) => p.functionCall ?? p.functionResponse);
    const callCounts = toolParts
      .filter((p) => p.functionCall)
      .reduce((acc, p) => {
        const name = p.functionCall.name ?? "unknown";
        acc[name] = (acc[name] ?? 0) + 1;
        return acc;
      }, {});

    console.log("[test-mcp-call] tool calls:", JSON.stringify(callCounts));
    const callDetails = toolParts
      .map((p) => ({
        functionCall: p.functionCall
          ? {
              name: p.functionCall.name ?? "",
              args: p.functionCall.args ?? {}
            }
          : null,
        functionResponse: p.functionResponse
          ? {
              name: p.functionResponse.name ?? "",
              hasResponse: p.functionResponse.response != null
            }
          : null
      }))
      .slice(0, 20);
    console.log("[test-mcp-call] tool call details:");
    console.log(JSON.stringify(callDetails, null, 2));
    console.log("[test-mcp-call] response:");
    console.log(response.text?.trim() ?? "");
  } finally {
    if (timer) clearTimeout(timer);
    await mcpClient.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[test-mcp-call] failed:", error);
  process.exit(1);
});
