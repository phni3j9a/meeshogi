import manifest from '../config/job-profiles.json' with { type: 'json' };
import type { SearchConditions } from './contract';

export type JobProfileId = 'free' | 'precision';
export type JobInstanceType = 'standard-2' | 'standard-3';

export type JobProfile = {
  instanceType: JobInstanceType;
  maxInstances: number;
  queueName: string;
  deadLetterQueueName: string;
  conditions: SearchConditions;
};

export type JobLimits = {
  timeZone: string;
  freeDailyJobs: number;
  freeRateWindowSeconds: number;
  freeRateMaxJobs: number;
  maxActiveJobsPerOwner: number;
};

export type JobExecutionConfig = {
  budgetMs: number;
  tailMarginMs: number;
  /** Transient execution attempts after the initial try. */
  maxRetries: number;
  /** Base delay for DO-owned retries, multiplied by the failed attempt number. */
  retryDelaySeconds: number;
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
      || !isPositiveInteger(row.maxInstances)
      || typeof row.queueName !== 'string' || !/^meeshogi-jobs-[a-z]+-staging$/u.test(row.queueName)
      || typeof row.deadLetterQueueName !== 'string' || !/^meeshogi-jobs-[a-z]+-staging-dlq$/u.test(row.deadLetterQueueName)
      || !isPositiveInteger(row.threads) || !isPositiveInteger(row.hashMb)
      || !isPositiveInteger(row.moveTimeMs) || !isPositiveInteger(row.multiPV)) {
      throw new Error(`job-profiles.json: profile "${id}" is missing or invalid`);
    }
    result[id] = {
      instanceType: row.instanceType as JobInstanceType,
      maxInstances: row.maxInstances,
      queueName: row.queueName,
      deadLetterQueueName: row.deadLetterQueueName,
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

function loadExecution(): JobExecutionConfig {
  const execution = manifest.execution as Record<string, unknown>;
  if (!isPositiveInteger(execution.budgetMs) || execution.budgetMs > 600_000
    || !isPositiveInteger(execution.tailMarginMs) || !isPositiveInteger(execution.maxRetries)
    || !isPositiveInteger(execution.retryDelaySeconds) || execution.tailMarginMs >= execution.budgetMs) {
    throw new Error('job-profiles.json: execution config is missing or invalid');
  }
  return execution as unknown as JobExecutionConfig;
}

export const JOB_PROFILES = loadProfiles();
export const JOB_LIMITS = loadLimits();
export const JOB_EXECUTION = loadExecution();
