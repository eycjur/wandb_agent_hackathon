/**
 * ログレベル管理。
 * 環境変数 GEPA_LOG_LEVEL で制御（off | error | info | debug）。
 * 後方互換: GEPA_LLM_CALL_LOGGING=1 のときは debug と同等。
 * UI から指定した場合は withLogLevelContext で上書き。
 */
import { AsyncLocalStorage } from "async_hooks";

export type LogLevel = "off" | "error" | "info" | "debug";

const LEVEL_ORDER: LogLevel[] = ["off", "error", "info", "debug"];

const logLevelStorage = new AsyncLocalStorage<{
  logLevel: LogLevel;
  /** debug 時のみ: LLM 呼び出しログを収集しフロントに返す */
  debugLogs?: string[];
}>();

function parseLevel(value: string | undefined): LogLevel {
  const v = value?.toLowerCase().trim();
  if (v === "off" || v === "error" || v === "info" || v === "debug") return v;
  return "off";
}

/** 現在のログレベルを取得（AsyncLocalStorage の上書き → 環境変数） */
export function getLogLevel(): LogLevel {
  const ctx = logLevelStorage.getStore();
  if (ctx?.logLevel) return ctx.logLevel;
  const envLevel = process.env.GEPA_LOG_LEVEL;
  const legacy = process.env.GEPA_LLM_CALL_LOGGING === "1";
  return legacy ? "debug" : parseLevel(envLevel);
}

/** 指定したログレベルで非同期処理を実行（UI からの上書き用） */
export async function withLogLevelContext<T>(
  level: LogLevel,
  fn: () => Promise<T>
): Promise<T> {
  const debugLogs = level === "debug" ? [] : undefined;
  return logLevelStorage.run({ logLevel: level, debugLogs }, fn);
}

/** debug 時: 収集用配列を取得。concurrencyLimiter が LLM ログを push する */
export function getDebugLogCollector(): string[] | undefined {
  return logLevelStorage.getStore()?.debugLogs;
}

/** debug 時: LLM 呼び出しログを収集（フロントの optimizationLog に含める） */
export function appendDebugLog(message: string): void {
  getDebugLogCollector()?.push(message);
}

function levelEnabled(minLevel: LogLevel): boolean {
  const current = getLogLevel();
  return LEVEL_ORDER.indexOf(current) >= LEVEL_ORDER.indexOf(minLevel);
}

export function isErrorEnabled(): boolean {
  return levelEnabled("error");
}

export function isInfoEnabled(): boolean {
  return levelEnabled("info");
}

export function isDebugEnabled(): boolean {
  return levelEnabled("debug");
}
