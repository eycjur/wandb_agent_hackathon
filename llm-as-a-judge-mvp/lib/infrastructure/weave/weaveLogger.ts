/**
 * Weave ロガー
 * 生成・評価・人間評価を Weave の op でトレースする。
 * @wandb/sdk は使用せず、weave のみで実現。
 */

import { getWeaveClient } from "./weaveClient";

export type LogGenerateParams = {
  domain: string;
  userInputLength: number;
  generatedOutputLength: number;
  /** 実際の入出力テキスト（Trace に含める） */
  userInput: string;
  generatedOutput: string;
};

export type LogJudgeParams = {
  domain: string;
  score: number;
  pass: boolean;
  passThreshold: number;
  rubricVersion: number;
  /** 実際の入出力・理由（Trace に含める） */
  userInput: string;
  generatedOutput: string;
  reason: string;
};

export type LogHumanFeedbackParams = {
  domain: string;
  humanScore: number;
  judgeScore?: number;
  /** 手動評価のコメント（Weave に保存） */
  humanComment?: string;
  userInput?: string;
  generatedOutput?: string;
  judgeResult?: { score: number; reason: string; pass: boolean };
};

async function getWeaveOp<T>(name: string, fn: (arg: T) => T | Promise<T>) {
  const client = await getWeaveClient();
  if (!client) return null;
  const weave = await import(/* @vite-ignore */ "weave");
  return weave.op(fn, { name });
}

/**
 * 生成結果を Weave にトレース
 */
export async function logGenerate(params: LogGenerateParams): Promise<void> {
  try {
    const op = await getWeaveOp<LogGenerateParams>("generate_log", (p) => p);
    if (!op) return;
    await op(params);
  } catch (err) {
    console.warn("[weave] logGenerate failed:", err);
  }
}

/**
 * 評価結果を Weave にトレース
 */
export async function logJudge(params: LogJudgeParams): Promise<void> {
  try {
    const op = await getWeaveOp<LogJudgeParams>("judge_log", (p) => p);
    if (!op) return;
    await op(params);
  } catch (err) {
    console.warn("[weave] logJudge failed:", err);
  }
}

/**
 * 人間評価を Weave にトレース
 */
export async function logHumanFeedback(params: LogHumanFeedbackParams): Promise<void> {
  try {
    const op = await getWeaveOp<LogHumanFeedbackParams>("human_feedback_log", (p) => p);
    if (!op) return;
    await op(params);
  } catch (err) {
    console.warn("[weave] logHumanFeedback failed:", err);
  }
}

export { isWeaveConfigured, getWeaveDashboardUrl } from "./weaveClient";
