import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationSourceType } from "@/lib/contracts/generateEvaluate";
import {
  listHumanFeedback,
  type HumanFeedbackRecord
} from "@/lib/infrastructure/humanFeedbackStore";
import {
  listEvaluationLogs,
  type EvaluationLogRecord
} from "@/lib/infrastructure/evaluationLogStore";
import {
  fetchHumanFeedbackWithJudgeMerged,
  fetchJudgeLogsFromWeave,
  type HumanFeedbackFromWeave,
  type JudgeLogFromWeave
} from "@/lib/infrastructure/weave/weaveQuery";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";

const VALID_DOMAINS: DomainId[] = ["resume_summary", "resume_detail", "self_pr"];

export function normalizeDomainId(domain: string): DomainId {
  return VALID_DOMAINS.includes(domain as DomainId)
    ? (domain as DomainId)
    : "resume_summary";
}

function normalizeSourceType(
  sourceType?: EvaluationSourceType
): EvaluationSourceType {
  return sourceType ?? "generated";
}

function isTargetOptimizationEligible(record: Pick<EvaluationLogRecord, "sourceType">): boolean {
  return normalizeSourceType(record.sourceType) === "generated";
}

export function toHumanFeedbackRecordFromWeave(
  record: HumanFeedbackFromWeave
): HumanFeedbackRecord {
  return {
    id: record.id,
    domain: normalizeDomainId(record.domain),
    userInput: record.userInput ?? "",
    generatedOutput: record.generatedOutput ?? "",
    sourceType: normalizeSourceType(record.sourceType),
    judgeResult:
      record.judgeResult ??
      (record.judgeScore != null
        ? { score: record.judgeScore, reason: "", pass: false }
        : undefined),
    humanScore: record.humanScore,
    humanComment: record.humanComment,
    createdAt: record.createdAt
  };
}

export function toEvaluationLogRecordFromWeave(
  record: JudgeLogFromWeave
): EvaluationLogRecord {
  return {
    id: record.id,
    domain: normalizeDomainId(record.domain),
    userInput: record.userInput ?? "",
    generatedOutput: record.generatedOutput ?? "",
    sourceType: normalizeSourceType(record.sourceType),
    judgeResult: {
      score: record.score,
      reason: record.reason ?? "",
      pass: record.pass,
      passThreshold: record.passThreshold,
      rubricVersion: record.rubricVersion
    },
    createdAt: record.createdAt
  };
}

export async function loadJudgeFeedbackForPromptOptimization(
  domain: DomainId,
  feedbackLimit: number
): Promise<HumanFeedbackRecord[]> {
  if (isWeaveConfigured()) {
    try {
      const fromWeave = await fetchHumanFeedbackWithJudgeMerged({
        domain,
        limit: feedbackLimit
      });
      return fromWeave.map(toHumanFeedbackRecordFromWeave);
    } catch {
      // fall through to in-memory store only when Weave request itself fails
    }
  }

  return listHumanFeedback({ domain, limit: feedbackLimit });
}

export async function loadTargetFailuresForPromptOptimization(
  domain: DomainId,
  failedLimit: number,
  minScore?: number
): Promise<EvaluationLogRecord[]> {
  void minScore;

  if (isWeaveConfigured()) {
    try {
      const fromWeave = await fetchJudgeLogsFromWeave({
        domain,
        limit: Math.max(failedLimit * 3, failedLimit)
      });
      return fromWeave
        .map(toEvaluationLogRecordFromWeave)
        .filter(isTargetOptimizationEligible)
        .slice(0, failedLimit);
    } catch {
      // fall through to in-memory store only when Weave request itself fails
    }
  }

  const records = await listEvaluationLogs({
    domain,
    limit: Math.max(failedLimit * 3, failedLimit)
  });
  return records
    .filter(isTargetOptimizationEligible)
    .slice(0, failedLimit);
}

export async function loadTargetExamplesForFewShot(
  domain: DomainId,
  limit: number
): Promise<EvaluationLogRecord[]> {
  if (isWeaveConfigured()) {
    try {
      const fromWeave = await fetchJudgeLogsFromWeave({
        domain,
        limit: Math.max(limit * 3, limit)
      });
      return fromWeave
        .map(toEvaluationLogRecordFromWeave)
        .filter(
          (r) =>
            isTargetOptimizationEligible(r) &&
            r.userInput.trim().length > 0 &&
            r.generatedOutput.trim().length > 0
        )
        .sort((a, b) => {
          if (b.judgeResult.score !== a.judgeResult.score) {
            return b.judgeResult.score - a.judgeResult.score;
          }
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        })
        .slice(0, limit);
    } catch {
      // fall through to in-memory store when Weave request fails
    }
  }

  const records = await listEvaluationLogs({
    domain,
    limit: Math.max(limit * 3, limit)
  });
  return records
    .filter(
      (r) =>
        isTargetOptimizationEligible(r) &&
        r.userInput.trim().length > 0 &&
        r.generatedOutput.trim().length > 0
    )
    .sort((a, b) => {
      if (b.judgeResult.score !== a.judgeResult.score) {
        return b.judgeResult.score - a.judgeResult.score;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, limit);
}
