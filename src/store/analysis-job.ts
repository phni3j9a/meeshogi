export type AnalysisJobStatus = 'running' | 'paused' | 'partial' | 'error';

export type AnalysisJob = {
  gameId: string;
  status: AnalysisJobStatus;
  /** Number of compatible saved results, including results reused at start. */
  completed: number;
  total: number;
  /** Positions skipped by the current start/resume because their budget was insufficient. */
  budgetShortfallPlies: number[];
  error?: string;
};

export function analysisJobProcessed(
  job: Pick<AnalysisJob, 'completed' | 'total' | 'budgetShortfallPlies'>,
) {
  return Math.min(job.total, job.completed + job.budgetShortfallPlies.length);
}

export function partialAnalysisMessage(
  job: Pick<AnalysisJob, 'completed' | 'total' | 'budgetShortfallPlies'>,
): string {
  const shortfalls = job.budgetShortfallPlies.length;
  return `解析処理が終了しました。${job.completed} / ${job.total}局面を解析済み、${shortfalls}局面は探索量不足です。設定の解析量（ノード数）を増やすか、「この局面を深く解析」をお試しください。`;
}
