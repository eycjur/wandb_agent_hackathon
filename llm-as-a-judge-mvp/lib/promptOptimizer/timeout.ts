/**
 * タイムアウトユーティリティ。
 * 最適化ループは時間がかかる場合があるため、
 * X秒で強制終了するデッドラインチェッカーを提供する。
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Optimization timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * タイムアウトのデッドラインチェッカーを作成する。
 * 返された関数を呼ぶと、デッドラインを過ぎている場合 true を返す。
 *
 * @example
 * const isDeadlineExceeded = createDeadlineChecker(30_000); // 30秒
 * for (...) {
 *   if (isDeadlineExceeded()) break; // タイムアウトで打ち切り
 *   ...
 * }
 */
export function createDeadlineChecker(timeoutMs: number | undefined): () => boolean {
  if (timeoutMs == null) return () => false;
  const deadline = Date.now() + timeoutMs;
  return () => Date.now() >= deadline;
}

/**
 * 単一の Promise にタイムアウトを適用する。
 * タイムアウト時は TimeoutError をスローする。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
