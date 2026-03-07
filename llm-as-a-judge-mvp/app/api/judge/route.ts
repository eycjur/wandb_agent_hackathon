import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import {
  ErrorCode,
  JudgeRequestSchema,
  JudgeSuccessResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { getLLMProvider } from "@/lib/infrastructure/llmProviderFactory";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message
      }
    },
    {
      status
    }
  );
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "JSON形式が不正です。");
  }

  const parsedRequest = JudgeRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    const firstIssue = parsedRequest.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  try {
    const provider = getLLMProvider({
      llmProvider: parsedRequest.data.llmProvider,
      improvementMethod: parsedRequest.data.improvementMethod
    });
    const judgeResult = await provider.judgeOutput(
      parsedRequest.data.userInput,
      parsedRequest.data.generatedOutput,
      parsedRequest.data.domain
    );

    const pass = judgeResult.score >= judgeResult.passThreshold;
    const response = JudgeSuccessResponseSchema.parse({
      domain: judgeResult.domain,
      rubricVersion: judgeResult.rubricVersion,
      passThreshold: judgeResult.passThreshold,
      pass,
      score: judgeResult.score,
      reason: judgeResult.reason
    });

    // wandb にログ（非同期、失敗してもレスポンスは返す）
    const { logJudge } = await import("@/lib/infrastructure/weave/weaveLogger");
    logJudge({
      domain: judgeResult.domain,
      score: judgeResult.score,
      pass,
      passThreshold: judgeResult.passThreshold,
      rubricVersion: judgeResult.rubricVersion,
      sourceType: parsedRequest.data.sourceType,
      userInput: parsedRequest.data.userInput,
      generatedOutput: parsedRequest.data.generatedOutput,
      reason: judgeResult.reason
    }).catch((err) => console.warn("[judge] weave log failed:", err));

    // 評価結果を保存（生成プロンプト改善の失敗ケース収集に利用）
    const { saveEvaluationLog } = await import("@/lib/infrastructure/evaluationLogStore");
    saveEvaluationLog({
      domain: judgeResult.domain,
      userInput: parsedRequest.data.userInput,
      generatedOutput: parsedRequest.data.generatedOutput,
      sourceType: parsedRequest.data.sourceType,
      judgeResult: {
        score: judgeResult.score,
        reason: judgeResult.reason,
        pass,
        passThreshold: judgeResult.passThreshold,
        rubricVersion: judgeResult.rubricVersion
      }
    }).catch((err) => console.warn("[judge] evaluation log save failed:", err));

    return NextResponse.json(response, {
      status: 200
    });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 502) {
        console.error(
          `[/api/judge] 502 PROVIDER_ERROR: code=${error.code} message=${error.exposeMessage} detail=${error.message}`
        );
      }
      return jsonError(error.status, error.code, error.exposeMessage);
    }

    if (error instanceof ZodError) {
      return jsonError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "プロバイダー応答形式が不正です。"
      );
    }

    console.error("[/api/judge] unexpected error:", error);
    return jsonError(500, "INTERNAL_ERROR", "予期しないエラーが発生しました。");
  }
}
