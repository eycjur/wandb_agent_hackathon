import { AppError } from "@/lib/errors";
import { NextRequest, NextResponse } from "next/server";
import { GenerateAndEvaluateUseCase } from "@/lib/application/generateAndEvaluateUseCase";
import {
  ErrorCode,
  GenerateEvaluateRequestSchema,
  GenerateEvaluateSuccessResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { getLLMProvider } from "@/lib/infrastructure/llmProviderFactory";
import { ZodError } from "zod";

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

  const parsedRequest = GenerateEvaluateRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    const firstIssue = parsedRequest.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  const provider = getLLMProvider({
    llmProvider: parsedRequest.data.llmProvider,
    improvementMethod: parsedRequest.data.improvementMethod
  });
  const useCase = new GenerateAndEvaluateUseCase(provider);

  try {
    const result = await useCase.execute(
      parsedRequest.data.userInput,
      parsedRequest.data.domain
    );
    const response = GenerateEvaluateSuccessResponseSchema.parse(result);

    return NextResponse.json(response, {
      status: 200
    });
  } catch (error: unknown) {
    if (error instanceof AppError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.exposeMessage
          }
        },
        {
          status: error.status
        }
      );
    }

    if (error instanceof ZodError) {
      return jsonError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "プロバイダー応答形式が不正です。"
      );
    }

    console.error("[/api/generate-evaluate] unexpected error:", error);
    return jsonError(500, "INTERNAL_ERROR", "予期しないエラーが発生しました。");
  }
}
