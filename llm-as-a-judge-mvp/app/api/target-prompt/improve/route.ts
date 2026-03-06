import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  TargetPromptImproveRequestSchema,
  TargetPromptImproveResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { generateTargetPromptImprovement } from "@/lib/application/targetPromptImproveUseCase";
import {
  loadTargetExamplesForFewShot,
  loadTargetFailuresForPromptOptimization
} from "@/lib/application/promptOptimization/gepaDataLoader";

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
    const loadedRecords =
      parsed.data.llmProvider === "ax" && parsed.data.improvementMethod === "fewshot"
        ? await loadTargetExamplesForFewShot(
            parsed.data.domain,
            parsed.data.failedLimit
          )
        : await loadTargetFailuresForPromptOptimization(
            parsed.data.domain,
            parsed.data.failedLimit,
            parsed.data.minScore
          );
    const selectedIdSet = new Set(parsed.data.selectedRecordIds);
    const failedRecords =
      selectedIdSet.size > 0
        ? loadedRecords.filter((record) => selectedIdSet.has(record.id))
        : loadedRecords;

    const result = await generateTargetPromptImprovement(failedRecords, parsed.data.domain, {
      llmProvider: parsed.data.llmProvider,
      improvementMethod: parsed.data.improvementMethod,
      gepaBudget: parsed.data.gepaBudget,
      fewShotBudget: parsed.data.fewShotBudget,
      logLevel: parsed.data.logLevel
    });

    const response = TargetPromptImproveResponseSchema.parse(result);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 502) {
        console.error(
          `[/api/target-prompt/improve] 502 PROVIDER_ERROR: code=${error.code} message=${error.exposeMessage} detail=${error.message}`
        );
      }
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/target-prompt/improve] error:", error);
    return jsonError(500, "INTERNAL_ERROR", "改善案の生成に失敗しました。");
  }
}
