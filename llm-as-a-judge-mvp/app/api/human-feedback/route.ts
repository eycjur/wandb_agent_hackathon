import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  HumanFeedbackRequestSchema,
  HumanFeedbackListResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { saveHumanFeedback, listHumanFeedback } from "@/lib/infrastructure/humanFeedbackStore";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status }
  );
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "JSON形式が不正です。");
  }

  const parsed = HumanFeedbackRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  try {
    const record = await saveHumanFeedback({
      domain: parsed.data.domain,
      userInput: parsed.data.userInput,
      generatedOutput: parsed.data.generatedOutput,
      judgeResult: parsed.data.judgeResult,
      humanScore: parsed.data.humanScore,
      humanComment: parsed.data.humanComment
    });

    return NextResponse.json({ id: record.id, createdAt: record.createdAt }, { status: 201 });
  } catch (error) {
    console.error("[/api/human-feedback] POST error:", error);
    return jsonError(500, "INTERNAL_ERROR", "人間評価の保存に失敗しました。");
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain");
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 100) : 50;

  const validDomains = ["resume_summary", "resume_detail", "self_pr"] as const;
  const domainFilter = domain && validDomains.includes(domain as (typeof validDomains)[number])
    ? (domain as (typeof validDomains)[number])
    : undefined;

  try {
    const records = await listHumanFeedback({ domain: domainFilter, limit });
    const response = HumanFeedbackListResponseSchema.parse({ records });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error("[/api/human-feedback] GET error:", error);
    return jsonError(500, "INTERNAL_ERROR", "人間評価の取得に失敗しました。");
  }
}
