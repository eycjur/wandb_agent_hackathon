import { NextRequest, NextResponse } from "next/server";
import {
  type ErrorCode,
  GepaJobEnqueueRequestSchema,
  GepaJobEnqueueResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { getGepaJobService } from "@/lib/application/gepaJobService";

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

  const parsed = GepaJobEnqueueRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  if (parsed.data.llmProvider !== "ax" || parsed.data.improvementMethod !== "gepa") {
    return jsonError(
      400,
      "VALIDATION_ERROR",
      "GEPA ジョブは llmProvider=ax かつ improvementMethod=gepa で実行してください。"
    );
  }

  try {
    const service = getGepaJobService();
    const job = service.enqueue(parsed.data);
    const response = GepaJobEnqueueResponseSchema.parse({
      jobId: job.jobId,
      kind: job.kind,
      domain: job.domain,
      status: job.status
    });
    return NextResponse.json(response, { status: 202 });
  } catch (error) {
    if (error instanceof AppError) {
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/gepa-jobs] enqueue error:", error);
    return jsonError(500, "INTERNAL_ERROR", "GEPA ジョブ投入に失敗しました。");
  }
}
