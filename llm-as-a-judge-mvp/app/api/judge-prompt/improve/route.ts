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
    const feedbackRecords = await loadJudgeFeedbackForPromptOptimization(
      parsed.data.domain,
      parsed.data.feedbackLimit
    );

    const result = await generateJudgePromptImprovement(feedbackRecords, parsed.data.domain, {
      llmProvider: parsed.data.llmProvider,
      improvementMethod: parsed.data.improvementMethod
    });

    const response = JudgePromptImproveResponseSchema.parse(result);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof AppError) {
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/judge-prompt/improve] error:", error);
    return jsonError(500, "INTERNAL_ERROR", "改善案の生成に失敗しました。");
  }
}
