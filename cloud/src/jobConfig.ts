import manifest from '../config/job-profiles.json' with { type: 'json' };
import type { SearchConditions } from './contract';

export type JobProfileId = 'free' | 'precision';
export type JobInstanceType = 'standard-2' | 'standard-3';

export type JobProfile = {
  instanceType: JobInstanceType;
  conditions: SearchConditions;
};

export type JobLimits = {
  timeZone: string;
  freeDailyJobs: number;
  freeRateWindowSeconds: number;
  freeRateMaxJobs: number;
  maxActiveJobsPerOwner: number;
};

export type JobConsumerConfig = {
  budgetMs: number;
  tailMarginMs: number;
  /** Standard Queue retries after the first delivery; total deliveries = maxRetries + 1. Must match wrangler.staging.jsonc queues.consumers[].max_retries. */
  maxRetries: number;
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function loadProfiles(): Record<JobProfileId, JobProfile> {
  const profiles = manifest.profiles as Record<string, Record<string, unknown>>;
  const result = {} as Record<JobProfileId, JobProfile>;
  for (const id of ['free', 'precision'] as const) {
    const row = profiles[id];
    if (!row || !['standard-2', 'standard-3'].includes(String(row.instanceType))
      || !isPositiveInteger(row.threads) || !isPositiveInteger(row.hashMb)
      || !isPositiveInteger(row.moveTimeMs) || !isPositiveInteger(row.multiPV)) {
      throw new Error(`job-profiles.json: profile "${id}" is missing or invalid`);
    }
    result[id] = {
      instanceType: row.instanceType as JobInstanceType,
      conditions: {
        threads: row.threads,
        hashMb: row.hashMb,
        moveTimeMs: row.moveTimeMs,
        multiPV: row.multiPV,
      },
    };
  }
  return result;
}

function loadLimits(): JobLimits {
  const limits = manifest.limits as Record<string, unknown>;
  if (limits.timeZone !== 'Asia/Tokyo'
    || !isPositiveInteger(limits.freeDailyJobs)
    || !isPositiveInteger(limits.freeRateWindowSeconds)
    || !isPositiveInteger(limits.freeRateMaxJobs)
    || !isPositiveInteger(limits.maxActiveJobsPerOwner)) {
    throw new Error('job-profiles.json: limits are missing or invalid');
  }
  return limits as unknown as JobLimits;
}

function loadConsumer(): JobConsumerConfig {
  const consumer = manifest.consumer as Record<string, unknown>;
  if (!isPositiveInteger(consumer.budgetMs) || !isPositiveInteger(consumer.tailMarginMs)
    || !isPositiveInteger(consumer.maxRetries) || consumer.tailMarginMs >= consumer.budgetMs) {
    throw new Error('job-profiles.json: consumer config is missing or invalid');
  }
  return consumer as unknown as JobConsumerConfig;
}

export const JOB_PROFILES = loadProfiles();
export const JOB_LIMITS = loadLimits();
export const JOB_CONSUMER = loadConsumer();
