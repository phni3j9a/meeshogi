import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { getStatistics } from '@/domain';
import { OPENING_LABELS, Opening, Service, Side } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { AppText, EmptyState, TextButton } from '@/ui/primitives';
import { GameRow } from '@/ui/game-row';
import { monthKey, Period, periodGames, periodLabel, Rate } from '@/ui/statistics-view';
import { useTheme } from '@/ui/theme';
import { useChoice } from '@/ui/use-choice';

export default function OpeningStatisticsScreen() {
  const params = useLocalSearchParams<{
    id: string;
    period?: Period;
    anchor?: string;
    side?: Side;
    service?: Service;
    openingSide?: 'self' | 'opponent';
  }>();
  const games = useAppStore((state) => state.games);
  const theme = useTheme();
  const choose = useChoice();
  const [otherOpening, setOtherOpening] = useState<Opening>();
  const opening = params.id in OPENING_LABELS ? (params.id as Opening) : 'unknown';
  const openingSide = params.openingSide === 'opponent' ? 'opponent' : 'self';
  const period = params.period ?? '1';
  const anchor = params.anchor ?? monthKey(new Date());
  const stats = useMemo(() => {
    const candidates = periodGames(games, period, anchor).filter((game) => {
      if (!otherOpening || !game.mySide) return true;
      const side =
        openingSide === 'self' ? (game.mySide === 'black' ? 'white' : 'black') : game.mySide;
      return (game.openings[side].manual ?? game.openings[side].automatic) === otherOpening;
    });
    return getStatistics(candidates, {
      side: params.side,
      service: params.service,
      opening,
      openingSide,
    });
  }, [games, period, anchor, otherOpening, openingSide, params.side, params.service, opening]);
  const chooseOther = async () => {
    const value = await choose(openingSide === 'self' ? '相手の戦型' : '自分の戦型', [
      { label: 'すべて', value: 'all' },
      ...Object.entries(OPENING_LABELS).map(([value, label]) => ({ value, label })),
    ]);
    if (value) setOtherOpening(value === 'all' ? undefined : (value as Opening));
  };
  return (
    <FlashList
      data={stats.games}
      keyExtractor={(game) => game.id}
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 36 }}
      ListHeaderComponent={
        <>
          <AppText variant="title" style={{ marginTop: 16 }}>
            {OPENING_LABELS[opening]}
          </AppText>
          <AppText tone="secondary" style={{ marginTop: 4, marginBottom: 24 }}>
            {openingSide === 'self' ? '自分の戦型' : '相手の戦型'}・{periodLabel(period, anchor)}
          </AppText>
          <Rate tally={stats} />
          <View
            style={{
              flexDirection: 'row',
              gap: 20,
              borderTopWidth: 0.5,
              borderTopColor: theme.border,
              paddingTop: 16,
              marginTop: 24,
            }}
          >
            <View style={{ flex: 1 }}>
              <Rate tally={stats.sides.black} compact label="先手" />
            </View>
            <View
              style={{
                flex: 1,
                borderLeftColor: theme.border,
                borderLeftWidth: 0.5,
                paddingLeft: 20,
              }}
            >
              <Rate tally={stats.sides.white} compact label="後手" />
            </View>
          </View>
          <TextButton
            label={`${openingSide === 'self' ? '相手' : '自分'}の戦型：${otherOpening ? OPENING_LABELS[otherOpening] : 'すべて'}`}
            icon="down"
            onPress={() => void chooseOther()}
          />
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginTop: 20,
              marginBottom: 8,
            }}
          >
            <AppText variant="heading">この戦型の棋譜</AppText>
            <AppText tone="secondary">{stats.total}局</AppText>
          </View>
        </>
      }
      renderItem={({ item }) => (
        <GameRow
          game={item}
          showDate
          onPress={() => router.push({ pathname: '/game/[id]', params: { id: item.id } })}
        />
      )}
      ListEmptyComponent={
        <EmptyState
          title="該当する棋譜はありません"
          message="条件を変えると、ほかの対局を確認できます。"
          icon="stats"
        />
      }
    />
  );
}
