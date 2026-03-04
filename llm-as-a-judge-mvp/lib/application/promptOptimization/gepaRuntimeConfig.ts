import { MODEL_TIMEOUT_MS } from "@/lib/config/llm";

export type GepaCompileBudget = {
  numTrials: number;
  minibatchSize: number;
  earlyStoppingTrials: number;
  maxMetricCalls: number;
  maxIterations: number;
  compileTimeoutMs: number;
  metricCallTimeoutMs?: number;
  maxExamples: number;
  maxInputChars: number;
  maxOutputChars: number;
};

export const GEPA_JUDGE_FAST_UI_BUDGET: GepaCompileBudget = {
  numTrials: 2,
  minibatchSize: 1,
  earlyStoppingTrials: 1,
  maxMetricCalls: 8,
  maxIterations: 2,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 6, 180_000),
  maxExamples: 6,
  maxInputChars: 1000,
  maxOutputChars: 1000
};

export const GEPA_TARGET_FAST_UI_BUDGET: GepaCompileBudget = {
  numTrials: 2,
  minibatchSize: 1,
  earlyStoppingTrials: 1,
  maxMetricCalls: 8,
  maxIterations: 2,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 6, 180_000),
  metricCallTimeoutMs: 5000,
  maxExamples: 6,
  maxInputChars: 1000,
  maxOutputChars: 1000
};

export function truncateForGepa(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
