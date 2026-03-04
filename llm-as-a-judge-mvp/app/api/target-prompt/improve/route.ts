import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  TargetPromptImproveRequestSchema,
  TargetPromptImproveResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { generateTargetPromptImprovement } from "@/lib/application/targetPromptImproveUseCase";
import { loadTargetFailuresForPromptOptimization } from "@/lib/application/promptOptimization/gepaDataLoader";

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
    const failedRecords = await loadTargetFailuresForPromptOptimization(
      parsed.data.domain,
      parsed.data.failedLimit,
      parsed.data.minScore
    );

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
