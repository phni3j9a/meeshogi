import { describe, expect, it } from 'vitest';
import { analysisJobProcessed, partialAnalysisMessage } from '../../src/store/analysis-job';

describe('全局解析の部分終了表示と進捗', () => {
  it('進捗は保存成功と今回の探索量不足を合わせ、completedには不足を加えない', () => {
    const job = {
      completed: 80,
      total: 81,
      budgetShortfallPlies: [40],
    };
    expect(analysisJobProcessed(job)).toBe(81);
    expect(job.completed).toBe(80);
  });

  it('部分終了メッセージは全局成立と区別し、手動の再解析導線を示す', () => {
    expect(partialAnalysisMessage({ completed: 80, total: 81, budgetShortfallPlies: [40] })).toBe(
      '解析処理が終了しました。80 / 81局面を解析済み、1局面は探索量不足です。設定の解析量（ノード数）を増やすか、「この局面を深く解析」をお試しください。',
    );
  });
});
