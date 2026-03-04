import "server-only";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppError } from "@/lib/errors";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type {
  GepaJobEnqueueRequest,
  GepaJobKind,
  GepaJobStatus,
  LLMProviderId,
  AxMethodId
} from "@/lib/contracts/generateEvaluate";
import {
  generateJudgePromptImprovement,
  type JudgePromptImprovementResult
} from "@/lib/application/judgePromptImproveUseCase";
import {
  generateTargetPromptImprovement,
  type TargetPromptImprovementResult
} from "@/lib/application/targetPromptImproveUseCase";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import {
  loadJudgeFeedbackForPromptOptimization,
  loadTargetFailuresForPromptOptimization
} from "@/lib/application/promptOptimization/gepaDataLoader";

const MAX_JOBS = 200;
const DEFAULT_CONCURRENCY = 1;
const MIN_RECORD_LIMIT = 1;
const MAX_RECORD_LIMIT = 50;
const MIN_MIN_SCORE = 0;
const MAX_MIN_SCORE = 5;
const VALID_DOMAINS: DomainId[] = ["resume_summary", "resume_detail", "self_pr"];
const VALID_KINDS: GepaJobKind[] = ["judge", "target"];
const VALID_STATUSES: GepaJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
];
const VALID_PROVIDERS: LLMProviderId[] = ["ax", "gemini"];
const VALID_AX_METHODS: AxMethodId[] = ["signature", "few-shot", "gepa"];

type GepaJobResult = JudgePromptImprovementResult | TargetPromptImprovementResult;

type GepaJobError = {
  code: string;
  message: string;
};

export type GepaJobRecord = {
  jobId: string;
  kind: GepaJobKind;
  domain: DomainId;
  status: GepaJobStatus;
  llmProvider: LLMProviderId;
  axMethod: AxMethodId;
  feedbackLimit: number;
  failedLimit: number;
  minScore?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: GepaJobResult;
  error?: GepaJobError;
};

type GepaJobStatePayload = {
  jobs: GepaJobRecord[];
  queue: string[];
};

type PersistedJobParseResult =
  | {
      job: GepaJobRecord;
    }
  | {
      job: null;
      reason: string;
      jobId?: string;
    };

export type GepaJobServiceOptions = {
  concurrency?: number;
  maxJobs?: number;
  stateFilePath?: string | null;
  now?: () => Date;
  createJobId?: () => string;
  loadJudgeFeedback?: (
    domain: DomainId,
    feedbackLimit: number
  ) => Promise<HumanFeedbackRecord[]>;
  loadTargetFailures?: (
    domain: DomainId,
    failedLimit: number,
    minScore?: number
  ) => Promise<EvaluationLogRecord[]>;
  optimizeJudge?: (
    feedbackRecords: HumanFeedbackRecord[],
    domain: DomainId,
    options: { llmProvider: LLMProviderId; axMethod: AxMethodId }
  ) => Promise<JudgePromptImprovementResult>;
  optimizeTarget?: (
    failedRecords: EvaluationLogRecord[],
    domain: DomainId,
    options: { llmProvider: LLMProviderId; axMethod: AxMethodId }
  ) => Promise<TargetPromptImprovementResult>;
};

function generateJobId(): string {
  return `gepa_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function getDefaultStateFilePath(): string {
  const envPath = process.env.GEPA_JOB_STATE_FILE?.trim();
  if (envPath) return envPath;
  return join(tmpdir(), "llm-as-a-judge-mvp", "gepa-jobs-state.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toJobError(error: unknown): GepaJobError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.exposeMessage
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message:
      error instanceof Error
        ? error.message
        : "GEPA ジョブの実行に失敗しました。"
  };
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function toPersistedJobRecord(raw: unknown): PersistedJobParseResult {
  if (!isObject(raw)) {
    return { job: null, reason: "payload is not an object" };
  }

  const jobId = typeof raw.jobId === "string" ? raw.jobId : "";
  const kind = raw.kind;
  const domain = raw.domain;
  const status = raw.status;
  const llmProvider = raw.llmProvider;
  const axMethod = raw.axMethod;
  const feedbackLimit = Number(raw.feedbackLimit);
  const failedLimit = Number(raw.failedLimit);
  const minScore =
    raw.minScore == null || Number.isNaN(Number(raw.minScore))
      ? undefined
      : Number(raw.minScore);
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : undefined;
  const finishedAt =
    typeof raw.finishedAt === "string" ? raw.finishedAt : undefined;
  const parsedResultSource: JudgePromptImprovementResult["resultSource"] =
    isObject(raw.result) &&
    (raw.result.resultSource === "gepa" ||
      raw.result.resultSource === "fallback" ||
      raw.result.resultSource === "standard")
      ? raw.result.resultSource
      : "gepa";
  const result =
    isObject(raw.result) &&
    typeof raw.result.suggestion === "string" &&
    typeof raw.result.analysisSummary === "string"
      ? {
          suggestion: raw.result.suggestion,
          analysisSummary: raw.result.analysisSummary,
          resultSource: parsedResultSource,
          currentPrompt:
            typeof raw.result.currentPrompt === "string"
              ? raw.result.currentPrompt
              : undefined,
          degradedReason:
            typeof raw.result.degradedReason === "string"
              ? raw.result.degradedReason
              : undefined
        }
      : undefined;
  const error =
    isObject(raw.error) &&
    typeof raw.error.code === "string" &&
    typeof raw.error.message === "string"
      ? { code: raw.error.code, message: raw.error.message }
      : undefined;

  const jobIdForLog = jobId || undefined;
  if (!jobId) return { job: null, reason: "missing jobId" };
  if (!VALID_KINDS.includes(kind as GepaJobKind)) {
    return { job: null, jobId: jobIdForLog, reason: "invalid kind" };
  }
  if (!VALID_DOMAINS.includes(domain as DomainId)) {
    return { job: null, jobId: jobIdForLog, reason: "invalid domain" };
  }
  if (!VALID_STATUSES.includes(status as GepaJobStatus)) {
    return { job: null, jobId: jobIdForLog, reason: "invalid status" };
  }
  if (!VALID_PROVIDERS.includes(llmProvider as LLMProviderId)) {
    return { job: null, jobId: jobIdForLog, reason: "invalid llmProvider" };
  }
  if (!VALID_AX_METHODS.includes(axMethod as AxMethodId)) {
    return { job: null, jobId: jobIdForLog, reason: "invalid axMethod" };
  }
  if (!isIntegerInRange(feedbackLimit, MIN_RECORD_LIMIT, MAX_RECORD_LIMIT)) {
    return {
      job: null,
      jobId: jobIdForLog,
      reason: `feedbackLimit out of range: ${feedbackLimit}`
    };
  }
  if (!isIntegerInRange(failedLimit, MIN_RECORD_LIMIT, MAX_RECORD_LIMIT)) {
    return {
      job: null,
      jobId: jobIdForLog,
      reason: `failedLimit out of range: ${failedLimit}`
    };
  }
  if (
    minScore != null &&
    !isIntegerInRange(minScore, MIN_MIN_SCORE, MAX_MIN_SCORE)
  ) {
    return {
      job: null,
      jobId: jobIdForLog,
      reason: `minScore out of range: ${minScore}`
    };
  }
  if (!createdAt) {
    return { job: null, jobId: jobIdForLog, reason: "missing createdAt" };
  }

  return {
    job: {
      jobId,
      kind: kind as GepaJobKind,
      domain: domain as DomainId,
      status: status as GepaJobStatus,
      llmProvider: llmProvider as LLMProviderId,
      axMethod: axMethod as AxMethodId,
      feedbackLimit,
      failedLimit,
      minScore,
      createdAt,
      startedAt,
      finishedAt,
      result,
      error
    }
  };
}

export class GepaJobService {
  private jobs = new Map<string, GepaJobRecord>();
  private queue: string[] = [];
  private runningCount = 0;

  private readonly concurrency: number;
  private readonly maxJobs: number;
  private readonly stateFilePath: string | null;
  private readonly now: () => Date;
  private readonly createJobId: () => string;
  private readonly loadJudgeFeedbackImpl: (
    domain: DomainId,
    feedbackLimit: number
  ) => Promise<HumanFeedbackRecord[]>;
  private readonly loadTargetFailuresImpl: (
    domain: DomainId,
    failedLimit: number,
    minScore?: number
  ) => Promise<EvaluationLogRecord[]>;
  private readonly optimizeJudgeImpl: (
    feedbackRecords: HumanFeedbackRecord[],
    domain: DomainId,
    options: { llmProvider: LLMProviderId; axMethod: AxMethodId }
  ) => Promise<JudgePromptImprovementResult>;
  private readonly optimizeTargetImpl: (
    failedRecords: EvaluationLogRecord[],
    domain: DomainId,
    options: { llmProvider: LLMProviderId; axMethod: AxMethodId }
  ) => Promise<TargetPromptImprovementResult>;

  constructor(options: GepaJobServiceOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxJobs = Math.max(10, options.maxJobs ?? MAX_JOBS);
    this.stateFilePath =
      options.stateFilePath === null
        ? null
        : options.stateFilePath ?? getDefaultStateFilePath();
    this.now = options.now ?? (() => new Date());
    this.createJobId = options.createJobId ?? generateJobId;
    this.loadJudgeFeedbackImpl =
      options.loadJudgeFeedback ?? loadJudgeFeedbackForPromptOptimization;
    this.loadTargetFailuresImpl =
      options.loadTargetFailures ?? loadTargetFailuresForPromptOptimization;
    this.optimizeJudgeImpl =
      options.optimizeJudge ??
      ((feedbackRecords, domain, runOptions) =>
        generateJudgePromptImprovement(feedbackRecords, domain, runOptions));
    this.optimizeTargetImpl =
      options.optimizeTarget ??
      ((failedRecords, domain, runOptions) =>
        generateTargetPromptImprovement(failedRecords, domain, runOptions));

    this.restoreState();
    this.kickWorker();
  }

  enqueue(input: GepaJobEnqueueRequest): GepaJobRecord {
    if (input.llmProvider !== "ax" || input.axMethod !== "gepa") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "GEPA ジョブは llmProvider=ax かつ axMethod=gepa でのみ実行できます。"
      );
    }
    if (
      !isIntegerInRange(input.feedbackLimit, MIN_RECORD_LIMIT, MAX_RECORD_LIMIT) ||
      !isIntegerInRange(input.failedLimit, MIN_RECORD_LIMIT, MAX_RECORD_LIMIT) ||
      (input.minScore != null &&
        !isIntegerInRange(input.minScore, MIN_MIN_SCORE, MAX_MIN_SCORE))
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "GEPA ジョブの feedbackLimit/failedLimit/minScore が不正です。"
      );
    }

    const job: GepaJobRecord = {
      jobId: this.createJobId(),
      kind: input.kind,
      domain: input.domain,
      status: "queued",
      llmProvider: input.llmProvider,
      axMethod: input.axMethod,
      feedbackLimit: input.feedbackLimit,
      failedLimit: input.failedLimit,
      minScore: input.minScore,
      createdAt: this.now().toISOString()
    };

    this.jobs.set(job.jobId, job);
    this.queue.push(job.jobId);
    this.gc();
    this.persistState();
    this.kickWorker();

    return job;
  }

  getById(jobId: string): GepaJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  private kickWorker() {
    while (this.runningCount < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;
      this.runningCount += 1;
      void this.execute(jobId).finally(() => {
        this.runningCount -= 1;
        this.kickWorker();
      });
    }
  }

  private async execute(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = "running";
    job.startedAt = this.now().toISOString();
    this.persistState();

    try {
      const result =
        job.kind === "judge"
          ? await this.runJudgeOptimization(job)
          : await this.runTargetOptimization(job);
      job.result = result;
      job.status = "succeeded";
      job.error = undefined;
    } catch (error) {
      job.status = "failed";
      job.error = toJobError(error);
      job.result = undefined;
    } finally {
      job.finishedAt = this.now().toISOString();
      this.gc();
      this.persistState();
    }
  }

  private async runJudgeOptimization(
    job: GepaJobRecord
  ): Promise<JudgePromptImprovementResult> {
    const feedbackRecords = await this.loadJudgeFeedbackImpl(
      job.domain,
      job.feedbackLimit
    );
    return this.optimizeJudgeImpl(feedbackRecords, job.domain, {
      llmProvider: job.llmProvider,
      axMethod: job.axMethod
    });
  }

  private async runTargetOptimization(
    job: GepaJobRecord
  ): Promise<TargetPromptImprovementResult> {
    const failedRecords = await this.loadTargetFailuresImpl(
      job.domain,
      job.failedLimit,
      job.minScore
    );
    return this.optimizeTargetImpl(failedRecords, job.domain, {
      llmProvider: job.llmProvider,
      axMethod: job.axMethod
    });
  }

  private restoreState() {
    if (!this.stateFilePath) return;

    try {
      const rawText = readFileSync(this.stateFilePath, "utf8");
      const parsed = JSON.parse(rawText) as Partial<GepaJobStatePayload>;
      const rawJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      const rawQueue = Array.isArray(parsed.queue) ? parsed.queue : [];

      const restoredJobs: GepaJobRecord[] = [];
      for (const candidate of rawJobs) {
        const parsedJob = toPersistedJobRecord(candidate);
        if (!parsedJob.job) {
          console.warn(
            `[GepaJobService] skipped invalid persisted job${
              parsedJob.jobId ? ` (${parsedJob.jobId})` : ""
            }: ${parsedJob.reason}`
          );
          continue;
        }
        const job = parsedJob.job;
        if (job.status === "running") {
          job.status = "queued";
          job.startedAt = undefined;
          job.finishedAt = undefined;
          job.error = undefined;
        }
        restoredJobs.push(job);
      }

      this.jobs = new Map(restoredJobs.map((job) => [job.jobId, job]));

      const queuedIds = new Set<string>();
      for (const jobId of rawQueue) {
        if (typeof jobId !== "string") continue;
        if (this.jobs.get(jobId)?.status === "queued") queuedIds.add(jobId);
      }
      for (const job of restoredJobs) {
        if (job.status === "queued") queuedIds.add(job.jobId);
      }

      this.queue = [...queuedIds];
      this.gc();
      this.persistState();
    } catch {
      // No saved state or parse error: start with empty queue.
      this.jobs = new Map();
      this.queue = [];
    }
  }

  private persistState() {
    if (!this.stateFilePath) return;

    const snapshot: GepaJobStatePayload = {
      jobs: [...this.jobs.values()],
      queue: [...this.queue]
    };

    try {
      const dirPath = dirname(this.stateFilePath);
      mkdirSync(dirPath, { recursive: true });

      const tempPath = `${this.stateFilePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(snapshot), "utf8");
      renameSync(tempPath, this.stateFilePath);
    } catch (error) {
      console.warn("[GepaJobService] failed to persist queue state:", error);
    }
  }

  private gc() {
    this.queue = this.queue.filter(
      (jobId) => this.jobs.get(jobId)?.status === "queued"
    );
    if (this.jobs.size <= this.maxJobs) return;

    const completed = [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "canceled"
      )
      .sort((a, b) => {
        const aTs = new Date(a.finishedAt ?? a.createdAt).getTime();
        const bTs = new Date(b.finishedAt ?? b.createdAt).getTime();
        return aTs - bTs;
      });

    const removeCount = Math.max(0, this.jobs.size - this.maxJobs);
    for (const job of completed.slice(0, removeCount)) {
      this.jobs.delete(job.jobId);
    }
  }
}

declare global {
  var __gepaJobService__: GepaJobService | undefined;
}

export function getGepaJobService(): GepaJobService {
  if (!globalThis.__gepaJobService__) {
    globalThis.__gepaJobService__ = new GepaJobService();
  }
  return globalThis.__gepaJobService__;
}
