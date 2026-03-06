import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import {
  ErrorCode,
  GenerateRequestSchema,
  GenerateSuccessResponseSchema
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

  const parsedRequest = GenerateRequestSchema.safeParse(rawBody);
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
    const generatedOutput = await provider.generateOutput(
      parsedRequest.data.userInput,
      parsedRequest.data.domain
    );
    const response = GenerateSuccessResponseSchema.parse({
      generatedOutput
    });

    // wandb にログ（非同期、失敗してもレスポンスは返す）
    const { logGenerate } = await import("@/lib/infrastructure/weave/weaveLogger");
    logGenerate({
      domain: parsedRequest.data.domain,
      userInputLength: parsedRequest.data.userInput.length,
      generatedOutputLength: generatedOutput.length,
      userInput: parsedRequest.data.userInput,
      generatedOutput
    }).catch((err) => console.warn("[generate] weave log failed:", err));

    return NextResponse.json(response, {
      status: 200
    });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 502) {
        console.error(
          `[/api/generate] 502 PROVIDER_ERROR: code=${error.code} message=${error.exposeMessage} detail=${error.message}`
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

    console.error("[/api/generate] unexpected error:", error);
    return jsonError(500, "INTERNAL_ERROR", "予期しないエラーが発生しました。");
  }
}
