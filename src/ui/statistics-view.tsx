import React from 'react';
import { View } from 'react-native';
import { GameRecord, Tally } from '@/domain/model';
import { gameMonth } from '@/domain';
import { AppText } from './primitives';

export type Period = '1' | '3' | 'all';
export function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
export function periodGames(games: GameRecord[], period: Period, anchor: string) {
  if (period === 'all') return games;
  const [year, month] = anchor.split('-').map(Number);
  const start = monthKey(new Date(year, month - (period === '3' ? 3 : 1), 1));
  const end = monthKey(new Date(year, month, 1));
  return games.filter((game) => gameMonth(game) >= start && gameMonth(game) < end);
}
export function periodLabel(period: Period, anchor: string) {
  if (period === 'all') return '全期間';
  const [year, month] = anchor.split('-').map(Number);
  return period === '1' ? `${year}年${month}月` : `${year}年${month}月までの3か月`;
}
export function percentage(ratio: number | null) {
  return ratio === null ? null : ratio * 100;
}
export function formatPercentage(ratio: number | null) {
  return ratio === null ? '—' : `${percentage(ratio)!.toFixed(1)}%`;
}
export function Rate({
  tally,
  compact = false,
  label = '勝率',
}: {
  tally: Tally;
  compact?: boolean;
  label?: string;
}) {
  return (
    <View style={{ gap: compact ? 0 : 3 }}>
      <AppText variant={compact ? 'caption' : 'body'} tone="secondary">
        {label}
      </AppText>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <AppText
          variant="metric"
          selectable
          style={compact ? { fontSize: 34, lineHeight: 44 } : undefined}
        >
          {tally.winRate === null ? '—' : percentage(tally.winRate)!.toFixed(1)}
        </AppText>
        {tally.winRate !== null && (
          <AppText style={{ fontSize: compact ? 21 : 30, lineHeight: compact ? 30 : 42 }}>
            %
          </AppText>
        )}
      </View>
      <AppText variant={compact ? 'caption' : 'body'} tone="secondary">
        {tally.total}局　{tally.wins}勝 {tally.losses}敗
      </AppText>
      {!!(tally.draws || tally.interrupted || tally.unknown) && (
        <AppText variant="caption" tone="secondary">
          {[
            tally.draws ? `引き分け ${tally.draws}` : '',
            tally.interrupted ? `中断 ${tally.interrupted}` : '',
            tally.unknown ? `不明 ${tally.unknown}` : '',
          ]
            .filter(Boolean)
            .join('・')}
        </AppText>
      )}
    </View>
  );
}
