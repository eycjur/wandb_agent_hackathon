import { NextRequest, NextResponse } from "next/server";
import {
  ErrorCode,
  JudgePromptImproveRequestSchema,
  JudgePromptImproveResponseSchema
} from "@/lib/contracts/generateEvaluate";
import { AppError } from "@/lib/errors";
import { generateJudgePromptImprovement } from "@/lib/application/judgePromptImproveUseCase";
import { listHumanFeedback } from "@/lib/infrastructure/humanFeedbackStore";
import { fetchHumanFeedbackWithJudgeMerged } from "@/lib/infrastructure/weave/weaveQuery";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";
import type { DomainId } from "@/lib/config/domainPromptLoader";

function jsonError(status: number, code: ErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const VALID_DOMAINS: DomainId[] = ["resume_summary", "resume_detail", "self_pr"];

/** Weave の HumanFeedbackFromWeave を HumanFeedbackRecord 形式に変換 */
function toHumanFeedbackRecord(
  r: Awaited<ReturnType<typeof fetchHumanFeedbackWithJudgeMerged>>[number]
) {
  const domain = VALID_DOMAINS.includes(r.domain as DomainId) ? (r.domain as DomainId) : "resume_summary";
  const judgeResult =
    r.judgeResult ?? (r.judgeScore != null ? { score: r.judgeScore, reason: "", pass: false } : undefined);
  return {
    id: r.id,
    domain,
    userInput: r.userInput ?? "",
    generatedOutput: r.generatedOutput ?? "",
    judgeResult,
    humanScore: r.humanScore,
    humanComment: r.humanComment,
    createdAt: r.createdAt
  };
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "JSON形式が不正です。");
  }

  const parsed = JudgePromptImproveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION_ERROR",
      firstIssue?.message ?? "入力値が不正です。"
    );
  }

  try {
    let feedbackRecords: Awaited<ReturnType<typeof listHumanFeedback>>;

    if (isWeaveConfigured()) {
      try {
        const fromWeave = await fetchHumanFeedbackWithJudgeMerged({
          domain: parsed.data.domain,
          limit: parsed.data.feedbackLimit
        });
        feedbackRecords = fromWeave.map(toHumanFeedbackRecord);
      } catch {
        feedbackRecords = [];
      }
    } else {
      feedbackRecords = [];
    }

    if (feedbackRecords.length === 0) {
      feedbackRecords = await listHumanFeedback({
        domain: parsed.data.domain,
        limit: parsed.data.feedbackLimit
      });
    }

    const result = await generateJudgePromptImprovement(feedbackRecords, parsed.data.domain, {
      llmProvider: parsed.data.llmProvider,
      axMethod: parsed.data.axMethod
    });

    const response = JudgePromptImproveResponseSchema.parse(result);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof AppError) {
      return jsonError(error.status, error.code, error.exposeMessage);
    }
    console.error("[/api/judge-prompt/improve] error:", error);
    return jsonError(500, "INTERNAL_ERROR", "改善案の生成に失敗しました。");
  }
}
