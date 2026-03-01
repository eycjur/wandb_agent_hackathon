import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GepaJobService,
  type GepaJobServiceOptions
} from "@/lib/application/gepaJobService";

const tempDirs: string[] = [];

function createTempStateFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gepa-job-service-test-"));
  tempDirs.push(dir);
  return join(dir, "queue-state.json");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GepaJobService", () => {
  it("ジョブ完了時に状態を永続化し、succeededで取得できる", async () => {
    const stateFilePath = createTempStateFilePath();
    let tick = 0;

    const service = new GepaJobService({
      stateFilePath,
      createJobId: () => "job_1",
      now: () => new Date(1700000000000 + tick++ * 1000),
      loadJudgeFeedback: async () => [
        {
          id: "hf_1",
          domain: "resume_summary",
          userInput: "input",
          generatedOutput: "output",
          judgeResult: { score: 3, reason: "ok", pass: false },
          humanScore: 2,
          humanComment: "comment",
          createdAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      optimizeJudge: async () => ({
        suggestion: "optimized judge prompt",
        analysisSummary: "analysis",
        currentPrompt: "current prompt",
        resultSource: "gepa"
      })
    });

    const job = service.enqueue({
      kind: "judge",
      domain: "resume_summary",
      feedbackLimit: 10,
      failedLimit: 10,
      llmProvider: "ax",
      axMethod: "gepa"
    });

    expect(["queued", "running"]).toContain(job.status);

    await waitFor(() => service.getById("job_1")?.status === "succeeded");

    const finished = service.getById("job_1");
    expect(finished?.result?.suggestion).toBe("optimized judge prompt");

    const saved = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
      jobs: Array<{ jobId: string; status: string }>;
    };
    expect(saved.jobs.some((j) => j.jobId === "job_1" && j.status === "succeeded")).toBe(true);
  });

  it("再起動時にrunningジョブをqueuedへ戻して再実行できる", async () => {
    const stateFilePath = createTempStateFilePath();
    writeFileSync(
      stateFilePath,
      JSON.stringify({
        jobs: [
          {
            jobId: "job_restore",
            kind: "target",
            domain: "resume_summary",
            status: "running",
            llmProvider: "ax",
            axMethod: "gepa",
            feedbackLimit: 10,
            failedLimit: 10,
            createdAt: "2026-03-01T00:00:00.000Z"
          }
        ],
        queue: []
      }),
      "utf8"
    );

    const optimizeTarget = vi.fn<
      NonNullable<GepaJobServiceOptions["optimizeTarget"]>
    >(async () => ({
      suggestion: "optimized target prompt",
      analysisSummary: "analysis",
      resultSource: "gepa"
    }));

    const service = new GepaJobService({
      stateFilePath,
      loadTargetFailures: async () => [
        {
          id: "e1",
          domain: "resume_summary",
          userInput: "input",
          generatedOutput: "output",
          judgeResult: {
            score: 2,
            reason: "bad",
            pass: false,
            passThreshold: 4,
            rubricVersion: 1
          },
          createdAt: "2024-01-01T00:00:00.000Z"
        }
      ],
      optimizeTarget
    });

    await waitFor(() => service.getById("job_restore")?.status === "succeeded");

    expect(optimizeTarget).toHaveBeenCalledTimes(1);
    expect(service.getById("job_restore")?.result?.suggestion).toBe(
      "optimized target prompt"
    );
  });

  it("ax/gepa以外はenqueue時にVALIDATION_ERRORを投げる", () => {
    const service = new GepaJobService({
      stateFilePath: createTempStateFilePath()
    });

    expect(() =>
      service.enqueue({
        kind: "judge",
        domain: "resume_summary",
        feedbackLimit: 10,
        failedLimit: 10,
        llmProvider: "gemini",
        axMethod: "few-shot"
      })
    ).toThrowError(/VALIDATION_ERROR|GEPA ジョブ/);
  });
});
