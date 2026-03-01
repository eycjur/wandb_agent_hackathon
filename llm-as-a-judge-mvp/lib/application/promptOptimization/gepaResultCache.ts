import "server-only";

import { createHash } from "node:crypto";
import type { DomainId } from "@/lib/config/domainPromptLoader";

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_CACHE_SIZE = 100;
const MAX_FAILURE_COOLDOWN_SIZE = 100;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

declare global {
  var __gepaResultCache__: Map<string, CacheEntry<unknown>> | undefined;
  var __gepaFailureCooldownCache__: Map<string, CacheEntry<string>> | undefined;
}

function getStore(): Map<string, CacheEntry<unknown>> {
  if (!globalThis.__gepaResultCache__) {
    globalThis.__gepaResultCache__ = new Map<string, CacheEntry<unknown>>();
  }
  return globalThis.__gepaResultCache__;
}

function getFailureCooldownStore(): Map<string, CacheEntry<string>> {
  if (!globalThis.__gepaFailureCooldownCache__) {
    globalThis.__gepaFailureCooldownCache__ = new Map<string, CacheEntry<string>>();
  }
  return globalThis.__gepaFailureCooldownCache__;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function buildGepaCacheKey(
  kind: "judge" | "target",
  domain: DomainId,
  payload: unknown
): string {
  const hash = createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
  return `gepa:${kind}:${domain}:${hash}`;
}

export function getCachedGepaResult<T>(key: string): T | null {
  const store = getStore();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCachedGepaResult<T>(
  key: string,
  value: T,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): void {
  const store = getStore();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });

  while (store.size > MAX_CACHE_SIZE) {
    const oldestKey = store.keys().next().value;
    if (oldestKey == null) break;
    store.delete(oldestKey);
  }
}

export function getGepaFailureCooldownReason(key: string): string | null {
  const store = getFailureCooldownStore();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function setGepaFailureCooldown(
  key: string,
  reason: string,
  ttlMs: number = DEFAULT_FAILURE_COOLDOWN_MS
): void {
  const store = getFailureCooldownStore();
  const now = Date.now();
  for (const [entryKey, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(entryKey);
  }

  store.set(key, { value: reason, expiresAt: Date.now() + ttlMs });

  while (store.size > MAX_FAILURE_COOLDOWN_SIZE) {
    const oldestKey = store.keys().next().value;
    if (oldestKey == null) break;
    store.delete(oldestKey);
  }
}

export function clearGepaFailureCooldown(key: string): void {
  getFailureCooldownStore().delete(key);
}

export function clearGepaResultCacheForTest(): void {
  getStore().clear();
  getFailureCooldownStore().clear();
}
