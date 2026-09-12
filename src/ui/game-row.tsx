import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { GameRecord, OPENING_LABELS, SERVICE_LABELS, SIDE_LABELS } from '@/domain/model';
import { AppText, Icon } from './primitives';
import { useTheme } from './theme';
import { writtenDate } from './dates';

export function gameOutcome(game: GameRecord): '勝' | '負' | '分' | '中断' | '不明' | '観戦' {
  if (!game.mySide) return '観戦';
  if (game.result === 'draw') return '分';
  if (game.result === 'interrupted') return '中断';
  if (game.result === 'unknown') return '不明';
  return game.result === `${game.mySide}-win` ? '勝' : '負';
}
export function gameTitle(game: GameRecord) {
  return game.mySide
    ? `${game.mySide === 'black' ? game.whiteName : game.blackName} との対局`
    : `${game.blackName} 対 ${game.whiteName}`;
}
export function openingDescription(game: GameRecord) {
  const self = game.mySide ?? 'black';
  const opponent = self === 'black' ? 'white' : 'black';
  return `${OPENING_LABELS[game.openings[self].manual ?? game.openings[self].automatic]} 対 ${OPENING_LABELS[game.openings[opponent].manual ?? game.openings[opponent].automatic]}`;
}
export function GameRow({
  game,
  onPress,
  onLongPress,
  showDate = false,
}: {
  game: GameRecord;
  onPress: () => void;
  onLongPress?: () => void;
  showDate?: boolean;
}) {
  const theme = useTheme();
  const outcome = gameOutcome(game);
  const date = writtenDate(game.startedAt);
  const analyzed = Object.keys(game.analysis).length;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      testID={`game-${game.id}`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.inset : 'transparent', borderBottomColor: theme.border },
      ]}
    >
      <View
        style={[
          styles.result,
          {
            backgroundColor:
              outcome === '勝' ? theme.winSoft : outcome === '負' ? theme.lossSoft : theme.inset,
          },
        ]}
      >
        <AppText
          variant="headline"
          style={{
            color: outcome === '勝' ? theme.win : outcome === '負' ? theme.loss : theme.secondary,
            fontSize: outcome.length > 1 ? 11 : 18,
          }}
        >
          {outcome}
        </AppText>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <AppText variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
            {game.mySide
              ? game.mySide === 'black'
                ? game.whiteName
                : game.blackName
              : `${game.blackName} 対 ${game.whiteName}`}
          </AppText>
          {game.favorite && <Icon name="favoriteFill" size={13} />}
        </View>
        <AppText variant="caption" tone="secondary">
          {game.mySide ? SIDE_LABELS[game.mySide] : '観戦'}・{game.moves.length}手・
          {SERVICE_LABELS[game.service]}
        </AppText>
        <AppText variant="caption" tone="secondary" numberOfLines={1}>
          {openingDescription(game)}
        </AppText>
        <AppText variant="small" tone="muted">
          {analyzed === 0
            ? '未解析'
            : analyzed >= game.positions.length
              ? '解析済み'
              : `解析 ${analyzed}/${game.positions.length}局面`}
        </AppText>
      </View>
      <AppText variant="caption" tone="secondary">
        {showDate ? date.short : date.time}
      </AppText>
      <Icon name="next" color={theme.muted} size={18} />
    </Pressable>
  );
}
const styles = StyleSheet.create({
  row: {
    minHeight: 90,
    paddingVertical: 12,
    gap: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  result: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
