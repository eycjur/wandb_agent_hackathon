/**
 * W&B MCP Server を使った Judge プロンプト改善案生成
 * Gemini が Weave のトレースデータを MCP ツール経由で自律取得して分析する
 */
import { GoogleGenAI, mcpToTool } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppError } from "@/lib/errors";
import { JUDGE_MODEL, MCP_TIMEOUT_MS } from "@/lib/config/llm";

const WANDB_MCP_URL = "https://mcp.withwandb.com/mcp";

let _client: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY is not set.",
    );
  }
  if (!_client) {
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/**
 * W&B MCP Server に接続し、Gemini が Weave データを自律取得しながらテキストを生成する。
 * 内部で mcpToTool() を使い、SDK の automatic function calling でツール呼び出しループを処理する。
 */
export async function generateTextWithWandbMcp(
  prompt: string,
): Promise<string> {
  const wandbApiKey = process.env.WANDB_API_KEY;
  if (!wandbApiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "WANDB_API_KEY is not set.",
    );
  }

  const ai = getGeminiClient();

  const transport = new StreamableHTTPClientTransport(new URL(WANDB_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${wandbApiKey}` },
    },
  });

  const mcpClient = new Client({
    name: "llm-as-a-judge-mvp",
    version: "1.0.0",
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(
            504,
            "PROVIDER_TIMEOUT",
            "処理がタイムアウトしました。",
            "MCP + Model call timed out.",
          ),
        ),
      MCP_TIMEOUT_MS,
    );
  });

  try {
    console.log("[geminiMcpGenerator] connecting to W&B MCP server...");
    try {
      await Promise.race([mcpClient.connect(transport), timeoutPromise]);
    } catch (connectErr) {
      if (timer) clearTimeout(timer);
      if (connectErr instanceof AppError) throw connectErr;
      console.error(
        "[geminiMcpGenerator] failed to connect to W&B MCP server:",
        connectErr,
      );
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "モデル呼び出しに失敗しました。",
        `MCP connect failed: ${String(connectErr)}`,
      );
    }
    console.log(
      "[geminiMcpGenerator] connected. calling Gemini with MCP tools...",
    );
    const tool = mcpToTool(mcpClient);

    const response = await Promise.race([
      ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: prompt,
        config: {
          temperature: 0.3,
          tools: [tool],
          systemInstruction: [
            "# MCP",
            "あなたは W&B Weave のデータにアクセスできる MCP ツールを持っています。",
            "与えられたケースで不足する情報がある場合は、 MCP ツール（query_weave_traces_tool, query_wandb_tool など）を呼び出して取得してください。",
            "ツールを呼び出さずに推測や架空のデータで回答することは禁止です。",
          ].join("\n"),
        },
      }),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);

    // Gemini が MCP 経由で呼び出したツールとその結果をログ出力
    // 自動関数呼び出し時の履歴は automaticFunctionCallingHistory に格納される
    const history = response.automaticFunctionCallingHistory ?? [];
    const toolParts = history
      .flatMap((c) => c.parts ?? [])
      .filter((p) => p.functionCall ?? p.functionResponse);
    if (toolParts.length > 0) {
      const callCounts = toolParts
        .filter((p) => p.functionCall)
        .reduce<Record<string, number>>((acc, p) => {
          const name = p.functionCall!.name ?? "unknown";
          acc[name] = (acc[name] ?? 0) + 1;
          return acc;
        }, {});
      console.log(
        "[geminiMcpGenerator] MCP tool calls:",
        JSON.stringify(callCounts),
      );
    } else {
      console.warn(
        "[geminiMcpGenerator] no MCP tool calls detected. Gemini may not have used the tools.",
      );
    }

    const text = response.text?.trim();

    if (!text) {
      console.error(
        "[geminiMcpGenerator] empty response. candidates:",
        JSON.stringify(
          response.candidates?.map((c) => ({
            finishReason: c.finishReason,
            parts: c.content?.parts?.length,
          })),
        ),
      );
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "モデルから有効な応答を取得できませんでした。",
        "Empty response from Gemini MCP call.",
      );
    }
    console.log("[geminiMcpGenerator] success. response length:", text.length);
    return text;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof AppError) throw error;
    console.error("[geminiMcpGenerator] unexpected error:", error);
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      "モデル呼び出しに失敗しました。",
      "Gemini MCP call failed.",
    );
  } finally {
    await mcpClient.close().catch(() => {});
  }
}
