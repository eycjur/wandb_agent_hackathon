/**
 * LLM API 呼び出しの同時実行数制限。
 * Gemini API のレート制限（RPM）を超えないよう、同時リクエスト数を抑える。
 *
 * 環境変数 GEPA_MAX_CONCURRENT_CALLS で制限値を指定可能（デフォルト: 20）
 * ログ: GEPA_LOG_LEVEL=debug で各呼び出しの開始・終了・所要時間・応答プレビュー（先頭100文字）を出力。
 *       GEPA_LOG_LEVEL=error 以上でエラー時のみ出力。
 *       後方互換: GEPA_LLM_CALL_LOGGING=1 は debug と同等。
 */
import pLimit from "p-limit";
import {
  isDebugEnabled,
  isErrorEnabled,
  appendDebugLog
} from "@/lib/promptOptimizer/logLevel";

const DEFAULT_LIMIT = 20;
const DEBUG_PREVIEW_CHARS = 100;

function getLimit(): number {
  const env = process.env.GEPA_MAX_CONCURRENT_CALLS;
  if (env == null || env === "") return DEFAULT_LIMIT;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 32) : DEFAULT_LIMIT;
}

function toPreview(value: unknown): string {
  if (typeof value === "string") {
    const s = value.replace(/\n/g, " ").trim();
    const content = s.length > DEBUG_PREVIEW_CHARS ? `${s.slice(0, DEBUG_PREVIEW_CHARS)}...` : s;
    return content ? `content: ${content}` : "";
  }
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sdk = obj.sdkHttpResponse && typeof obj.sdkHttpResponse === "object"
      ? (obj.sdkHttpResponse as Record<string, unknown>)
      : null;
    const statusCode =
      sdk?.statusCode ?? sdk?.status ?? obj.statusCode ?? (obj.text != null ? 200 : undefined);
    const statusStr = statusCode != null ? `statusCode=${statusCode}` : "statusCode=—";
    const content =
      typeof obj.text === "string"
        ? obj.text.replace(/\n/g, " ").trim()
        : obj.content && typeof (obj.content as { text?: string })?.text === "string"
          ? ((obj.content as { text?: string }).text ?? "").replace(/\n/g, " ").trim()
          : "";
    const contentPreview =
      content.length > DEBUG_PREVIEW_CHARS ? `${content.slice(0, DEBUG_PREVIEW_CHARS)}...` : content;
    return `${statusStr} content: ${contentPreview || "(empty)"}`;
  }
  return String(value).slice(0, DEBUG_PREVIEW_CHARS);
}

let limiterInstance: ReturnType<typeof pLimit> | null = null;
let callCounter = 0;

export function getLlmConcurrencyLimiter(): ReturnType<typeof pLimit> {
  if (limiterInstance == null) {
    limiterInstance = pLimit(getLimit());
  }
  return limiterInstance;
}

/** limiter(fn) で LLM 呼び出しをラップする */
export function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limiter = getLlmConcurrencyLimiter();
  const debug = isDebugEnabled();
  const error = isErrorEnabled();

  const wrapped = async (): Promise<T> => {
    const id = ++callCounter;
    const start = Date.now();
    if (debug) {
      const startMsg = `[llm] #${id} start`;
      console.log(startMsg);
      appendDebugLog(startMsg);
    }
    try {
      const result = await fn();
      if (debug) {
        const elapsed = Date.now() - start;
        const preview = toPreview(result);
        const endMsg = `[llm] #${id} end ${elapsed}ms`;
        console.log(endMsg);
        appendDebugLog(endMsg);
        if (preview) {
          const respMsg = `[llm] #${id} response: ${preview}`;
          console.log(respMsg);
          appendDebugLog(respMsg);
        }
      }
      return result;
    } catch (err) {
      if (debug || error) {
        const errMsg = `[llm] #${id} error ${Date.now() - start}ms — ${err instanceof Error ? err.message : String(err)}`;
        console.log(errMsg);
        if (debug) appendDebugLog(errMsg);
      }
      throw err;
    }
  };

  return limiter(wrapped);
}
