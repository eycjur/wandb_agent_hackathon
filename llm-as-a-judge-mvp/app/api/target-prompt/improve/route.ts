import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  TargetPromptImproveRequestSchema,
  TargetPromptImproveResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { generateTargetPromptImprovement } from "@/lib/application/targetPromptImproveUseCase";
import { fetchJudgeLogsFromWeave } from "@/lib/infrastructure/weave/weaveQuery";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";
import { listFailedEvaluations } from "@/lib/infrastructure/evaluationLogStore";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type { JudgeLogFromWeave } from "@/lib/infrastructure/weave/weaveQuery";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const VALID_DOMAINS: DomainId[] = ["resume_summary", "resume_detail", "self_pr"];

/** Weave の JudgeLogFromWeave を EvaluationLogRecord 形式に変換 */
function toEvaluationLogRecord(
  r: JudgeLogFromWeave
): EvaluationLogRecord {
  const domain = VALID_DOMAINS.includes(r.domain as DomainId) ? r.domain as DomainId : "resume_summary";
  return {
    id: r.id,
    domain,
    userInput: r.userInput ?? "",
    generatedOutput: r.generatedOutput ?? "",
    judgeResult: {
      score: r.score,
      reason: r.reason ?? "",
      pass: r.pass,
      passThreshold: r.passThreshold,
      rubricVersion: r.rubricVersion
    },
    createdAt: r.createdAt
  };
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "JSON形式が不正です。");
  }

  const parsed = TargetPromptImproveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  try {
    const promptConfig = await getDomainPromptConfig(parsed.data.domain);
    const minScore = parsed.data.minScore ?? promptConfig.passThreshold;

    let failedRecords: EvaluationLogRecord[];

    if (isWeaveConfigured()) {
      try {
        const fromWeave = await fetchJudgeLogsFromWeave({
          domain: parsed.data.domain,
          limit: parsed.data.failedLimit * 2
        });
        const converted = fromWeave.map(toEvaluationLogRecord);
        failedRecords = converted
          .filter((r) => !r.judgeResult.pass || r.judgeResult.score < minScore)
          .slice(0, parsed.data.failedLimit);
      } catch {
        failedRecords = await listFailedEvaluations({
          domain: parsed.data.domain,
          limit: parsed.data.failedLimit,
          minScore
        });
      }
    } else {
      failedRecords = await listFailedEvaluations({
        domain: parsed.data.domain,
        limit: parsed.data.failedLimit,
        minScore
      });
    }

    const result = await generateTargetPromptImprovement(failedRecords, parsed.data.domain, {
      llmProvider: parsed.data.llmProvider,
      axMethod: parsed.data.axMethod
    });

    const response = TargetPromptImproveResponseSchema.parse(result);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof AppError) {
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/target-prompt/improve] error:", error);
    return jsonError(500, "INTERNAL_ERROR", "改善案の生成に失敗しました。");
  }
}
