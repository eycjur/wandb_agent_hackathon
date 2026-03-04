import { NextRequest, NextResponse } from "next/server";
import {
  type ErrorCode,
  GepaJobStatusResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { getGepaJobService } from "@/lib/application/gepaJobService";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

type Params = { jobId: string };

export async function GET(
  _request: NextRequest,
  context: { params: Promise<Params> | Params }
) {
  const params = await Promise.resolve(context.params);
  if (!params.jobId || params.jobId.trim() === "") {
    return jsonError(400, "VALIDATION_ERROR", "jobId が不正です。");
  }

  const service = getGepaJobService();
  const job = service.getById(params.jobId);
  if (!job) {
    return jsonError(404, "VALIDATION_ERROR", "指定された GEPA ジョブが見つかりません。");
  }

  const response = GepaJobStatusResponseSchema.parse({
    jobId: job.jobId,
    kind: job.kind,
    domain: job.domain,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error
  });
  return NextResponse.json(response, { status: 200 });
}
