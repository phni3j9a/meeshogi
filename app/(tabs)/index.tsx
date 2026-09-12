import React, { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '@/store/app-store';
import { GameRecord } from '@/domain/model';
import { shareKif } from '@/platform/kif-files';
import {
  AppText,
  EmptyState,
  Group,
  Icon,
  IconButton,
  Notice,
  PageHeader,
  Segment,
} from '@/ui/primitives';
import { GameRow, gameTitle } from '@/ui/game-row';
import { writtenDate } from '@/ui/dates';
import { useTheme } from '@/ui/theme';
import { errorMessage, useChoice } from '@/ui/use-choice';

export default function LibraryScreen() {
  const theme = useTheme();
  const games = useAppStore((state) => state.games);
  const updateGame = useAppStore((state) => state.updateGame);
  const [favorite, setFavorite] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const choose = useChoice();
  const filtered = useMemo(
    () =>
      games
        .filter(
          (game) =>
            (!favorite || game.favorite) &&
            `${game.blackName} ${game.whiteName} ${game.startedAt}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => writtenDate(b.startedAt).key.localeCompare(writtenDate(a.startedAt).key)),
    [games, favorite, query],
  );
  const continuing = [...games]
    .filter((game) => game.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))[0];
  const open = (game: GameRecord) =>
    router.push({ pathname: '/game/[id]', params: { id: game.id } });
  const actions = async (game: GameRecord) => {
    const action = await choose(gameTitle(game), [
      { label: game.favorite ? 'お気に入りを解除' : 'お気に入りに追加', value: 'favorite' },
      { label: 'KIFを書き出す', value: 'share' },
    ]);
    try {
      if (action === 'favorite') await updateGame(game.id, { favorite: !game.favorite });
      else if (action === 'share') await shareKif(game);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <SafeAreaView
      edges={['top']}
      style={{ flex: 1, backgroundColor: theme.background }}
      testID="library-screen"
    >
      <FlashList
        data={filtered}
        keyExtractor={(game) => game.id}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <PageHeader title="棋譜">
              <IconButton
                name="search"
                label={searching ? '検索を閉じる' : '棋譜を検索'}
                testID="library-search-toggle"
                onPress={() => {
                  if (searching) setQuery('');
                  setSearching((value) => !value);
                }}
              />
              <IconButton
                name="add"
                label="棋譜を追加"
                testID="import-button"
                filled
                onPress={() => router.push('/import')}
              />
            </PageHeader>
            {searching && (
              <TextInput
                accessibilityLabel="棋譜を検索"
                testID="library-search-input"
                placeholder="対局者名・日付で検索"
                placeholderTextColor={theme.muted}
                defaultValue={query}
                onChangeText={setQuery}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={{
                  color: theme.text,
                  backgroundColor: theme.inset,
                  borderRadius: 12,
                  minHeight: 48,
                  paddingHorizontal: 14,
                  marginBottom: 12,
                }}
              />
            )}
            <Segment
              labels={['すべて', 'お気に入り']}
              selected={favorite ? 1 : 0}
              onChange={(index) => setFavorite(index === 1)}
            />
            {error && <Notice text={error} error action="閉じる" onAction={() => setError('')} />}
            {continuing && !query && !favorite && (
              <Pressable
                onPress={() => open(continuing)}
                accessibilityRole="button"
                style={{ marginTop: 16, marginBottom: 16 }}
              >
                <Group style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <AppText variant="caption" tone="secondary">
                      前回の続き
                    </AppText>
                    <AppText variant="headline" numberOfLines={2}>
                      {gameTitle(continuing)}
                    </AppText>
                    <AppText variant="caption" tone="secondary">
                      {continuing.lastViewedPly}手目から再開
                    </AppText>
                  </View>
                  <View
                    style={{ padding: 16, backgroundColor: theme.accentSoft, borderRadius: 14 }}
                  >
                    <Icon name="games" size={32} />
                  </View>
                  <Icon name="next" color={theme.muted} size={18} />
                </Group>
              </Pressable>
            )}
            {!!filtered.length && (
              <AppText
                variant="caption"
                tone="secondary"
                style={{ marginTop: 20, marginBottom: 4 }}
              >
                最近の対局 · {filtered.length}局
              </AppText>
            )}
          </>
        }
        renderItem={({ item, index }) => {
          const day = writtenDate(item.startedAt).day;
          const previousDay = index > 0 ? writtenDate(filtered[index - 1].startedAt).day : null;
          return (
            <>
              {day !== previousDay && (
                <AppText
                  variant="caption"
                  tone="secondary"
                  style={{ paddingTop: 16, paddingBottom: 4 }}
                >
                  {day}
                </AppText>
              )}
              <GameRow
                game={item}
                onPress={() => open(item)}
                onLongPress={() => void actions(item)}
              />
            </>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            title={
              query
                ? '棋譜が見つかりません'
                : favorite
                  ? 'お気に入りの棋譜'
                  : '最初の一局を振り返ろう'
            }
            message={
              query
                ? '別の対局者名や日付で検索できます。'
                : favorite
                  ? '棋譜のメニューからお気に入りに追加できます。'
                  : '将棋ウォーズ・棋桜からコピーした棋譜や、KIFファイルを追加できます。'
            }
            action={!query && !favorite ? '棋譜を追加' : undefined}
            onAction={() => router.push('/import')}
          />
        }
      />
    </SafeAreaView>
  );
}
