/**
 * 人間評価の保存
 * wandb にログし、一覧取得用にメモリ内に保持する。
 * WANDB_API_KEY 未設定時はメモリ内のみ（再起動で消失）。
 */

import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationSourceType } from "@/lib/contracts/generateEvaluate";
import { logHumanFeedback } from "./weave/weaveLogger";

export interface HumanFeedbackRecord {
  id: string;
  domain: DomainId;
  userInput: string;
  generatedOutput: string;
  sourceType: EvaluationSourceType;
  judgeResult?: {
    score: number;
    reason: string;
    pass: boolean;
  };
  humanScore: number;
  humanComment?: string;
  createdAt: string;
}

const records: HumanFeedbackRecord[] = [];

function generateId(): string {
  return `hf_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export interface SaveHumanFeedbackInput {
  domain: DomainId;
  userInput: string;
  generatedOutput: string;
  sourceType: EvaluationSourceType;
  judgeResult?: { score: number; reason: string; pass: boolean };
  humanScore: number;
  humanComment?: string;
}

export async function saveHumanFeedback(input: SaveHumanFeedbackInput): Promise<HumanFeedbackRecord> {
  const record: HumanFeedbackRecord = {
    id: generateId(),
    domain: input.domain,
    userInput: input.userInput,
    generatedOutput: input.generatedOutput,
    sourceType: input.sourceType,
    judgeResult: input.judgeResult,
    humanScore: input.humanScore,
    humanComment: input.humanComment,
    createdAt: new Date().toISOString()
  };

  records.push(record);

  logHumanFeedback({
    domain: input.domain,
    humanScore: input.humanScore,
    judgeScore: input.judgeResult?.score,
    humanComment: input.humanComment,
    userInput: input.userInput,
    generatedOutput: input.generatedOutput,
    sourceType: input.sourceType,
    judgeResult: input.judgeResult
  }).catch((err) => console.warn("[humanFeedbackStore] weave log failed:", err));

  return record;
}

export interface ListHumanFeedbackOptions {
  domain?: DomainId;
  limit?: number;
}

export async function listHumanFeedback(
  options: ListHumanFeedbackOptions = {}
): Promise<HumanFeedbackRecord[]> {
  let result = [...records];

  if (options.domain) {
    result = result.filter((r) => r.domain === options.domain);
  }

  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const limit = options.limit ?? 50;
  return result.slice(0, limit);
}
