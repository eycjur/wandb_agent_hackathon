import { describe, expect, it } from "vitest";
import {
  createInitialDomainSessions,
  patchDomainSession,
  selectDomainSession
} from "@/lib/ui/domainSession";

type DummyResult = {
  score: number;
};

describe("domainSession state", () => {
  it("ドメイン切替時に失敗状態とエラーメッセージを保持できる", () => {
    const initialSessions = createInitialDomainSessions<DummyResult>();
    const withDetailError = patchDomainSession(initialSessions, "resume_detail", {
      progressStage: "failed_generating",
      requestError: "生成に失敗しました。"
    });

    const summarySession = selectDomainSession(withDetailError, "resume_summary");
    const detailSession = selectDomainSession(withDetailError, "resume_detail");

    expect(summarySession.progressStage).toBe("idle");
    expect(summarySession.requestError).toBe("");
    expect(detailSession.progressStage).toBe("failed_generating");
    expect(detailSession.requestError).toBe("生成に失敗しました。");
  });

  it("再実行開始時に同一ドメインのエラーをクリアできる", () => {
    const initialSessions = createInitialDomainSessions<DummyResult>();
    const failedSessions = patchDomainSession(initialSessions, "self_pr", {
      progressStage: "failed_judging",
      requestError: "評価に失敗しました。"
    });
    const retryingSessions = patchDomainSession(failedSessions, "self_pr", {
      progressStage: "judging",
      requestError: ""
    });

    const selfPrSession = selectDomainSession(retryingSessions, "self_pr");
    expect(selfPrSession.progressStage).toBe("judging");
    expect(selfPrSession.requestError).toBe("");
  });

  it("更新対象以外のドメイン状態は変更されない", () => {
    const initialSessions = createInitialDomainSessions<DummyResult>();
    const updatedSessions = patchDomainSession(initialSessions, "resume_summary", {
      progressStage: "generated"
    });

    const detailSession = selectDomainSession(updatedSessions, "resume_detail");
    expect(detailSession.progressStage).toBe("idle");
    expect(detailSession.requestError).toBe("");
    expect(initialSessions.resume_summary.progressStage).toBe("idle");
  });
});
