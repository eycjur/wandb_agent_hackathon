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
  numTrials: 1,
  minibatchSize: 2,
  earlyStoppingTrials: 1,
  maxMetricCalls: 8,
  maxIterations: 1,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 4, 120_000),
  maxExamples: 5,
  maxInputChars: 1200,
  maxOutputChars: 1200
};

export const GEPA_TARGET_FAST_UI_BUDGET: GepaCompileBudget = {
  numTrials: 1,
  minibatchSize: 1,
  earlyStoppingTrials: 1,
  maxMetricCalls: 4,
  maxIterations: 1,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 4, 120_000),
  metricCallTimeoutMs: 7000,
  maxExamples: 4,
  maxInputChars: 1000,
  maxOutputChars: 1000
};

export const GEPA_JUDGE_ULTRA_FAST_BUDGET: GepaCompileBudget = {
  numTrials: 1,
  minibatchSize: 1,
  earlyStoppingTrials: 1,
  maxMetricCalls: 2,
  maxIterations: 1,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 2, 45_000),
  maxExamples: 3,
  maxInputChars: 900,
  maxOutputChars: 900
};

export const GEPA_TARGET_ULTRA_FAST_BUDGET: GepaCompileBudget = {
  numTrials: 1,
  minibatchSize: 1,
  earlyStoppingTrials: 1,
  maxMetricCalls: 2,
  maxIterations: 1,
  compileTimeoutMs: Math.max(MODEL_TIMEOUT_MS * 2, 45_000),
  metricCallTimeoutMs: 5000,
  maxExamples: 3,
  maxInputChars: 900,
  maxOutputChars: 900
};

export function truncateForGepa(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
