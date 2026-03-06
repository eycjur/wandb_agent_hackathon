import { NextRequest, NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import {
  getDomainPromptConfig
} from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import {
  DomainConfigResponseSchema,
  DomainIdSchema
} from "@/lib/contracts/generateEvaluate";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domainParam = searchParams.get("domain") ?? "resume_summary";
  const domainResult = DomainIdSchema.safeParse(domainParam);
  const domain: DomainId = domainResult.success
    ? domainResult.data
    : "resume_summary";

  try {
    const config = await getDomainPromptConfig(domain);

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
      if (error.status === 502) {
        console.error(
          `[/api/domain-config] 502 PROVIDER_ERROR: code=${error.code} message=${error.exposeMessage} detail=${error.message}`
        );
      }
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
