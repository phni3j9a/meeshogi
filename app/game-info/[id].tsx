import React, { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  OPENING_LABELS,
  RESULT_LABELS,
  effectiveResult,
  GameResult,
  Opening,
  SERVICE_LABELS,
  Service,
  Side,
  SIDE_LABELS,
} from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { shareKif } from '@/platform/kif-files';
import {
  AppText,
  EmptyState,
  Group,
  Notice,
  PageScroll,
  Row,
  SectionLabel,
  TextButton,
} from '@/ui/primitives';
import { errorMessage, useChoice } from '@/ui/use-choice';
import { writtenDate } from '@/ui/dates';
import { FORMATION_LABELS, gameFormation } from '@/domain';

export default function GameInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useAppStore((state) => state.games.find((item) => item.id === id));
  const updateGame = useAppStore((state) => state.updateGame);
  const deleteGame = useAppStore((state) => state.deleteGame);
  const [error, setError] = useState('');
  const choose = useChoice();
  if (!game)
    return <EmptyState title="棋譜が見つかりません" message="棋譜一覧から開き直してください。" />;
  const selectOpening = async (side: Side) => {
    const value = await choose(`${SIDE_LABELS[side]}の戦型`, [
      { label: '自動判定に戻す', value: 'automatic' },
      ...Object.entries(OPENING_LABELS).map(([value, label]) => ({ value, label })),
    ]);
    if (!value) return;
    try {
      await updateGame(id, {
        openings: {
          ...game.openings,
          [side]: {
            ...game.openings[side],
            manual: value === 'automatic' ? null : (value as Opening),
          },
        },
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const selectSide = async () => {
    const value = await choose('自分の手番', [
      { label: '先手', value: 'black' },
      { label: '後手', value: 'white' },
      { label: '自分を含まない（戦績の対象外）', value: 'none' },
    ]);
    if (value)
      try {
        await updateGame(id, { mySide: value === 'none' ? null : (value as Side) });
      } catch (e) {
        setError(errorMessage(e));
      }
  };
  return (
    <PageScroll>
      {error && <Notice text={error} error />}
      <SectionLabel>対局</SectionLabel>
      <Group>
        <Row label="先手" value={game.blackName} />
        <Row label="後手" value={game.whiteName} />
        <Row label="対局日時" value={writtenDate(game.startedAt).full} />
        <Row label="時間設定" value={game.timeControl || '記載なし'} />
        <Row
          label="結果"
          value={`${RESULT_LABELS[effectiveResult(game)]}${game.manualResult ? '（手動）' : ''}`}
          testID="game-result"
          onPress={() =>
            void choose('対局結果', [
              { label: '棋譜の結果に戻す', value: 'original' },
              ...Object.entries(RESULT_LABELS).map(([value, label]) => ({ value, label })),
            ]).then(async (value) => {
              if (!value) return;
              try {
                await updateGame(id, {
                  manualResult: value === 'original' ? null : (value as GameResult),
                });
              } catch (e) {
                setError(errorMessage(e));
              }
            })
          }
          last
        />
      </Group>
      {game.manualResult && (
        <AppText variant="caption" tone="secondary" style={{ paddingTop: 8 }}>
          修正した結果を戦績に使います。KIFの書き出しでは元の棋譜を保ちます。
        </AppText>
      )}
      <SectionLabel>自分の戦績</SectionLabel>
      <Group>
        <Row
          label="自分の手番"
          value={game.mySide ? SIDE_LABELS[game.mySide] : '戦績の対象外'}
          onPress={() => void selectSide()}
        />
        <Row
          label="サービス"
          value={SERVICE_LABELS[game.service]}
          onPress={() =>
            void choose(
              '対局サービス',
              Object.entries(SERVICE_LABELS).map(([value, label]) => ({
                value: value as Service,
                label,
              })),
            ).then(async (value) => {
              if (value)
                try {
                  await updateGame(id, { service: value });
                } catch (e) {
                  setError(errorMessage(e));
                }
            })
          }
          last
        />
      </Group>
      <SectionLabel>戦型</SectionLabel>
      <Group>
        <Row label="対戦構図" value={FORMATION_LABELS[gameFormation(game)]} />
        {(['black', 'white'] as Side[]).map((side, index) => (
          <Row
            key={side}
            label={`${SIDE_LABELS[side]}の戦型`}
            value={`${OPENING_LABELS[game.openings[side].manual ?? game.openings[side].automatic]}${game.openings[side].manual ? '（手動）' : ''}`}
            onPress={() => void selectOpening(side)}
            last={index === 1}
          />
        ))}
      </Group>
      <AppText variant="caption" tone="secondary" style={{ paddingTop: 8 }}>
        手動で修正した戦型は、自動分類で上書きしません。
      </AppText>
      <TextButton
        label="KIFを書き出す"
        icon="share"
        onPress={() => void shareKif(game).catch((e) => setError(errorMessage(e)))}
      />
      <TextButton
        label="この棋譜を削除"
        icon="delete"
        onPress={() =>
          Alert.alert(
            '棋譜を削除しますか？',
            'この端末の棋譜と解析結果を削除します。戦績にも反映されます。',
            [
              { text: 'キャンセル', style: 'cancel' },
              {
                text: '削除',
                style: 'destructive',
                onPress: () =>
                  void deleteGame(id)
                    .then(() => router.dismissTo('/'))
                    .catch((e) => setError(errorMessage(e))),
              },
            ],
          )
        }
      />
    </PageScroll>
  );
}
