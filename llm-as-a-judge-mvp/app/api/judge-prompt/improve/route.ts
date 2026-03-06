import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  JudgePromptImproveRequestSchema,
  JudgePromptImproveResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { generateJudgePromptImprovement } from "@/lib/application/judgePromptImproveUseCase";
import { loadJudgeFeedbackForPromptOptimization } from "@/lib/application/promptOptimization/gepaDataLoader";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "JSON形式が不正です。");
  }

  const parsed = JudgePromptImproveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  try {
    const loadedRecords = await loadJudgeFeedbackForPromptOptimization(
      parsed.data.domain,
      parsed.data.feedbackLimit
    );
    const selectedIdSet = new Set(parsed.data.selectedRecordIds);
    const feedbackRecords =
      selectedIdSet.size > 0
        ? loadedRecords.filter((record) => selectedIdSet.has(record.id))
        : loadedRecords;

    const result = await generateJudgePromptImprovement(feedbackRecords, parsed.data.domain, {
      llmProvider: parsed.data.llmProvider,
      improvementMethod: parsed.data.improvementMethod,
      gepaBudget: parsed.data.gepaBudget,
      fewShotBudget: parsed.data.fewShotBudget
    });

    const response = JudgePromptImproveResponseSchema.parse(result);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 502) {
        console.error(
          `[/api/judge-prompt/improve] 502 PROVIDER_ERROR: code=${error.code} message=${error.exposeMessage} detail=${error.message}`
        );
      }
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/judge-prompt/improve] error:", error);
    return jsonError(500, "INTERNAL_ERROR", "改善案の生成に失敗しました。");
  }
}
