export const TARGET_MODEL = "gemini-2.5-flash";
export const JUDGE_MODEL = "gemini-2.5-pro";
export const GEPA_MODEL = "gemini-2.5-flash";
export const MODEL_TIMEOUT_MS = 20_000;
/** プロンプト改善（長文入力・長文出力）用のタイムアウト */
export const PROMPT_IMPROVE_TIMEOUT_MS = 60_000;
/** Few-shot 最適化（コンパイル）用のタイムアウト */
export const FEWSHOT_OPTIMIZE_TIMEOUT_MS = 300_000;
/** W&B MCP Server 経由の呼び出し（ツール往復を含む）用のタイムアウト */
export const MCP_TIMEOUT_MS = 120_000;
