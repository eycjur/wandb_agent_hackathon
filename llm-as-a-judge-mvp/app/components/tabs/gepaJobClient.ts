import type {
  GepaJobEnqueueResponse,
  GepaJobStatusResponse
} from "@/lib/contracts/generateEvaluate";

const VALID_KINDS = new Set(["judge", "target"]);
const VALID_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
]);
const VALID_DOMAINS = new Set(["resume_summary", "resume_detail", "self_pr"]);

export function isGepaEnqueueResponse(
  data: unknown
): data is GepaJobEnqueueResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.jobId === "string" &&
    d.jobId.trim() !== "" &&
    typeof d.kind === "string" &&
    VALID_KINDS.has(d.kind) &&
    typeof d.domain === "string" &&
    VALID_DOMAINS.has(d.domain) &&
    typeof d.status === "string" &&
    VALID_STATUSES.has(d.status)
  );
}

export function isGepaStatusResponse(
  data: unknown
): data is GepaJobStatusResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.jobId === "string" &&
    d.jobId.trim() !== "" &&
    typeof d.kind === "string" &&
    VALID_KINDS.has(d.kind) &&
    typeof d.domain === "string" &&
    VALID_DOMAINS.has(d.domain) &&
    typeof d.status === "string" &&
    VALID_STATUSES.has(d.status) &&
    typeof d.createdAt === "string" &&
    (d.startedAt === undefined || typeof d.startedAt === "string") &&
    (d.finishedAt === undefined || typeof d.finishedAt === "string")
  );
}
