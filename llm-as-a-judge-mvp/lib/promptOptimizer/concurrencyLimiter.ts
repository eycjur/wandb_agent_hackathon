/**
 * LLM API 呼び出しの同時実行数制限。
 * Gemini API のレート制限（RPM）を超えないよう、同時リクエスト数を抑える。
 *
 * 環境変数 GEPA_MAX_CONCURRENT_CALLS で制限値を指定可能（デフォルト: 20）
 * 環境変数 GEPA_LLM_CALL_LOGGING が "1" のとき、各呼び出しの開始・終了をログ出力
 */
import pLimit from "p-limit";

const DEFAULT_LIMIT = 20;

function getLimit(): number {
  const env = process.env.GEPA_MAX_CONCURRENT_CALLS;
  if (env == null || env === "") return DEFAULT_LIMIT;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 32) : DEFAULT_LIMIT;
}

function isCallLoggingEnabled(): boolean {
  return process.env.GEPA_LLM_CALL_LOGGING === "1";
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
  const logging = isCallLoggingEnabled();

  const wrapped = async (): Promise<T> => {
    const id = ++callCounter;
    const start = Date.now();
    if (logging) {
      console.log(`[llm] #${id} start`);
    }
    try {
      const result = await fn();
      if (logging) {
        console.log(`[llm] #${id} end ${Date.now() - start}ms`);
      }
      return result;
    } catch (err) {
      if (logging) {
        console.log(`[llm] #${id} error ${Date.now() - start}ms`);
      }
      throw err;
    }
  };

  return limiter(wrapped);
}
