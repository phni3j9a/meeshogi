import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { getStatistics } from '@/domain';
import { OPENING_LABELS, SERVICE_LABELS, Service, Side, SIDE_LABELS } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import {
  AppText,
  EmptyState,
  Icon,
  IconButton,
  PageHeader,
  PageScroll,
  Segment,
  TextButton,
} from '@/ui/primitives';
import { LineChart } from '@/ui/charts';
import {
  monthKey,
  Period,
  periodGames,
  periodLabel,
  Rate,
  percentage,
  formatPercentage,
} from '@/ui/statistics-view';
import { useTheme } from '@/ui/theme';
import { useChoice } from '@/ui/use-choice';

export default function StatisticsScreen() {
  const games = useAppStore((state) => state.games);
  const theme = useTheme();
  const choose = useChoice();
  const [period, setPeriod] = useState<Period>('1');
  const [anchor, setAnchor] = useState(monthKey(new Date()));
  const [side, setSide] = useState<Side>();
  const [service, setService] = useState<Service>();
  const [openingSide, setOpeningSide] = useState<'self' | 'opponent'>('self');
  const stats = useMemo(
    () => getStatistics(periodGames(games, period, anchor), { side, service, openingSide }),
    [games, period, anchor, side, service, openingSide],
  );
  const moveMonth = (direction: number) => {
    const [year, month] = anchor.split('-').map(Number);
    setAnchor(monthKey(new Date(year, month - 1 + direction, 1)));
  };
  const selectSide = async () => {
    const value = await choose('先後で絞り込む', [
      { label: 'すべて', value: 'all' },
      { label: '先手', value: 'black' },
      { label: '後手', value: 'white' },
    ]);
    if (value) setSide(value === 'all' ? undefined : (value as Side));
  };
  const selectService = async () => {
    const value = await choose('サービスで絞り込む', [
      { label: 'すべて', value: 'all' },
      ...Object.entries(SERVICE_LABELS).map(([value, label]) => ({ value, label })),
    ]);
    if (value) setService(value === 'all' ? undefined : (value as Service));
  };
  return (
    <SafeAreaView
      edges={['top']}
      style={{ flex: 1, backgroundColor: theme.background }}
      testID="statistics-screen"
    >
      <PageScroll>
        <PageHeader title="戦績">
          <IconButton
            name="filter"
            label="絞り込み条件をリセット"
            onPress={() => {
              setSide(undefined);
              setService(undefined);
            }}
          />
        </PageHeader>
        <Segment
          labels={['1か月', '3か月', '全期間']}
          selected={period === '1' ? 0 : period === '3' ? 1 : 2}
          onChange={(index) => setPeriod((['1', '3', 'all'] as Period[])[index])}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginVertical: 12,
          }}
        >
          {period !== 'all' && (
            <IconButton name="previous" label="前の月" onPress={() => moveMonth(-1)} />
          )}
          <AppText style={{ flex: 1, textAlign: 'center' }}>{periodLabel(period, anchor)}</AppText>
          {period !== 'all' && (
            <IconButton
              name="next"
              label="次の月"
              onPress={() => moveMonth(1)}
              disabled={anchor >= monthKey(new Date())}
            />
          )}
        </View>
        <Rate tally={stats} />
        <AppText variant="caption" tone="secondary" style={{ marginTop: 20, marginBottom: 4 }}>
          期間内の累計勝率
        </AppText>
        <LineChart
          values={stats.trend.map((point) => percentage(point.winRate))}
          percent
          height={110}
        />
        <View style={{ flexDirection: 'row', gap: 12, marginVertical: 16, flexWrap: 'wrap' }}>
          <TextButton
            label={`先後：${side ? SIDE_LABELS[side] : 'すべて'}`}
            icon="down"
            onPress={() => void selectSide()}
          />
          <TextButton
            label={`サービス：${service ? SERVICE_LABELS[service] : 'すべて'}`}
            icon="down"
            onPress={() => void selectService()}
          />
        </View>
        <AppText variant="heading" style={{ marginBottom: 10 }}>
          戦型別
        </AppText>
        <Segment
          labels={['自分の戦型', '相手の戦型']}
          selected={openingSide === 'self' ? 0 : 1}
          onChange={(index) => setOpeningSide(index === 0 ? 'self' : 'opponent')}
        />
        {stats.openings
          .filter((entry) => entry.tally.total > 0)
          .map(({ opening, tally }) => (
            <Pressable
              key={opening}
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: '/opening/[id]',
                  params: {
                    id: opening,
                    openingSide,
                    period,
                    anchor,
                    ...(side ? { side } : {}),
                    ...(service ? { service } : {}),
                  },
                })
              }
              style={({ pressed }) => ({
                paddingVertical: 16,
                borderBottomWidth: 0.5,
                borderBottomColor: theme.border,
                backgroundColor: pressed ? theme.inset : 'transparent',
                flexDirection: 'row',
                gap: 16,
                alignItems: 'center',
              })}
            >
              <View style={{ flex: 1, gap: 5 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <AppText variant="headline">{OPENING_LABELS[opening]}</AppText>
                  <AppText style={{ fontVariant: ['tabular-nums'] }}>
                    {formatPercentage(tally.winRate)}
                  </AppText>
                </View>
                <View style={{ height: 6, backgroundColor: theme.inset, borderRadius: 6 }}>
                  <View
                    style={{
                      width: `${percentage(tally.winRate) ?? 0}%`,
                      height: 6,
                      backgroundColor: theme.win,
                      borderRadius: 6,
                    }}
                  />
                </View>
                <AppText variant="caption" tone="secondary">
                  {tally.total}局・{tally.wins}勝 {tally.losses}敗
                </AppText>
              </View>
              <Icon name="next" color={theme.muted} size={18} />
            </Pressable>
          ))}
        {!stats.total && (
          <EmptyState
            icon="stats"
            title={
              games.some((game) => game.mySide)
                ? 'この期間の対局はありません'
                : '戦績はここにたまります'
            }
            message={
              games.length
                ? '自分の対局者名を設定し、棋譜の手番を確認してください。期間や条件でも絞り込めます。'
                : '棋譜を追加して自分の手番を選ぶと、勝敗や戦型別の成績を振り返れます。'
            }
          />
        )}
        <AppText variant="caption" tone="secondary" style={{ marginTop: 16 }}>
          勝率は勝ち ÷（勝ち＋負け）。自分を含まない棋譜は集計に含めません。
        </AppText>
      </PageScroll>
    </SafeAreaView>
  );
}
