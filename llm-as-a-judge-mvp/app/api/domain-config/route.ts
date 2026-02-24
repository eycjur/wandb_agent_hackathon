import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { getResumeSummaryPromptConfig } from "@/lib/config/resumeSummaryPromptLoader";
import { DomainConfigResponseSchema } from "@/lib/contracts/generateEvaluate";

export async function GET() {
  try {
    const config = await getResumeSummaryPromptConfig();

    const response = DomainConfigResponseSchema.parse({
      domain: config.domain,
      rubricVersion: config.rubricVersion,
      passThreshold: config.passThreshold,
      samples: config.samples
    });

    return NextResponse.json(response, {
      status: 200
    });
  } catch (error) {
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

    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "ドメイン設定の取得に失敗しました。"
        }
      },
      {
        status: 500
      }
    );
  }
}
