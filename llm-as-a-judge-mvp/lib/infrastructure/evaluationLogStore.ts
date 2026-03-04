/**
 * 評価結果ログの保存
 * Judge の評価結果を保存し、生成プロンプト改善の失敗ケース収集に利用
 * メモリ内に保持（再起動で消失）。
 */

import type { DomainId } from "@/lib/config/domainPromptLoader";

export interface EvaluationLogRecord {
  id: string;
  domain: DomainId;
  userInput: string;
  generatedOutput: string;
  judgeResult: {
    score: number;
    reason: string;
    pass: boolean;
    passThreshold: number;
    rubricVersion: number;
  };
  createdAt: string;
}

const records: EvaluationLogRecord[] = [];
const MAX_RECORDS = 500;

function generateId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export interface SaveEvaluationLogInput {
  domain: DomainId;
  userInput: string;
  generatedOutput: string;
  judgeResult: {
    score: number;
    reason: string;
    pass: boolean;
    passThreshold: number;
    rubricVersion: number;
  };
}

export async function saveEvaluationLog(input: SaveEvaluationLogInput): Promise<EvaluationLogRecord> {
  const record: EvaluationLogRecord = {
    id: generateId(),
    domain: input.domain,
    userInput: input.userInput,
    generatedOutput: input.generatedOutput,
    judgeResult: input.judgeResult,
    createdAt: new Date().toISOString()
  };

  records.push(record);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }

  return record;
}

export interface ListFailedEvaluationsOptions {
  domain?: DomainId;
  limit?: number;
  minScore?: number;
}

export interface ListEvaluationLogsOptions {
  domain?: DomainId;
  limit?: number;
}

export async function listFailedEvaluations(
  options: ListFailedEvaluationsOptions = {}
): Promise<EvaluationLogRecord[]> {
  let result = [...records];

  if (options.domain) {
    result = result.filter((r) => r.domain === options.domain);
  }

  const minScore = options.minScore ?? 4;
  result = result.filter((r) => !r.judgeResult.pass || r.judgeResult.score < minScore);

  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const limit = options.limit ?? 10;
  return result.slice(0, limit);
}

export async function listEvaluationLogs(
  options: ListEvaluationLogsOptions = {}
): Promise<EvaluationLogRecord[]> {
  let result = [...records];

  if (options.domain) {
    result = result.filter((r) => r.domain === options.domain);
  }

  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const limit = options.limit ?? 50;
  return result.slice(0, limit);
}
