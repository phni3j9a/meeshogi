import React, { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useAppStore } from '@/store/app-store';
import {
  ANALYSIS_METHOD_LABELS,
  ANALYSIS_METHODS,
  Settings,
  cloudProfileOf,
  type AnalysisMethod,
} from '@/domain/model';
import { CLOUD_PROFILE_LABELS, isActiveAttempt } from '@/cloud/contract';
import { cloudEndpoint } from '@/cloud/config';
import { AppText, Group, Notice, PageHeader, PageScroll, Row, SectionLabel } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { PIECE_SETS } from '@/ui/piece-sets';
import { errorMessage, useChoice } from '@/ui/use-choice';

export default function SettingsScreen() {
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const cloudAttempts = useAppStore((state) => state.cloudAttempts);
  const games = useAppStore((state) => state.games);
  const cloudLoadError = useAppStore((state) => state.cloudLoadError);
  const [error, setError] = useState('');
  const theme = useTheme();
  const choose = useChoice();
  const profileId = cloudProfileOf(settings.analysisMethod);
  const runningAttempt = cloudAttempts.find((attempt) => isActiveAttempt(attempt.status));
  const runningGame = runningAttempt
    ? games.find((game) => game.id === runningAttempt.gameId)
    : undefined;
  const update = async (patch: Partial<Settings>) => {
    try {
      await updateSettings(patch);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toggle = (key: 'autoAnalyze' | 'showArrows' | 'showMateBadges' | 'haptics') => (
    <Switch
      value={settings[key]}
      onValueChange={(value) => void update({ [key]: value })}
      trackColor={{ true: theme.win, false: theme.inset }}
      accessibilityLabel={
        {
          autoAnalyze: '保存時に自動解析',
          showArrows: '候補手の矢印',
          showMateBadges: '詰めバッジ',
          haptics: '触覚フィードバック',
        }[key]
      }
    />
  );
  const playerNames = Object.values(settings.playerNames).flat();
  return (
    <SafeAreaView
      edges={['top']}
      style={{ flex: 1, backgroundColor: theme.background }}
      testID="settings-screen"
    >
      <PageScroll>
        <PageHeader title="設定" />
        {error ? <Notice text={error} error /> : null}
        <SectionLabel>対局者</SectionLabel>
        <Group>
          <Row
            label="対局者名"
            icon="person"
            value={
              playerNames.length
                ? `${playerNames[0]}${playerNames.length > 1 ? ` ほか${playerNames.length - 1}件` : ''}`
                : '未登録'
            }
            onPress={() => router.push('/player-names')}
            last
            testID="player-names-link"
          />
        </Group>
        <AppText variant="caption" tone="secondary" style={{ padding: 10 }}>
          棋譜の名前から先後・勝敗を判定します。
        </AppText>
        <SectionLabel>棋譜解析</SectionLabel>
        <Group>
          <Row
            label="解析方法"
            value={ANALYSIS_METHOD_LABELS[settings.analysisMethod]}
            onPress={() =>
              void choose(
                '解析方法',
                ANALYSIS_METHODS.map((value) => ({
                  label: ANALYSIS_METHOD_LABELS[value],
                  value,
                })),
              ).then((value: AnalysisMethod | undefined) => {
                if (value !== undefined) return update({ analysisMethod: value });
              })
            }
            testID="analysis-method"
          />
          {runningAttempt && runningGame && (
            <Row
              label="Cloud解析の実行中"
              value={`${CLOUD_PROFILE_LABELS[runningAttempt.profileId]}・${runningAttempt.serverNextPly}/${runningAttempt.totalPlies}局面`}
              onPress={() =>
                router.push({ pathname: '/game/[id]', params: { id: runningGame.id } })
              }
              testID="cloud-running-link"
            />
          )}
          <Row label="保存時に自動解析">{toggle('autoAnalyze')}</Row>
          <Row
            label="解析の長さ"
            value={
              settings.analysisNodes <= 1000
                ? '短め'
                : settings.analysisNodes <= 10000
                  ? '標準'
                  : '長め'
            }
            onPress={() =>
              void choose('一局の解析の長さ', [
                { label: '短め', value: 1000 },
                { label: '標準', value: 10000 },
                { label: '長め', value: 50000 },
              ]).then((value) => {
                if (value !== undefined) return update({ analysisNodes: value });
              })
            }
          />
          <Row
            label="候補手の数"
            value={`${settings.multiPV}候補`}
            onPress={() =>
              void choose(
                '候補手の数',
                [1, 2, 3].map((value) => ({ label: `${value}候補`, value })),
              ).then((value) => {
                if (value !== undefined) return update({ multiPV: value });
              })
            }
            last
          />
        </Group>
        <AppText variant="caption" tone="secondary" style={{ padding: 10 }}>
          {settings.analysisMethod === 'sekirei'
            ? '端末内で解析します。解析中も棋譜を操作できます。'
            : profileId
              ? `${CLOUD_PROFILE_LABELS[profileId]}：サーバーの解析エンジンで1局をまとめて解析します。解析中にアプリを閉じてもサーバーで処理が継続し、次回起動時に続きを受け取ります。分岐検討と「この局面を深く解析」は常に端末内（Sekirei）で行います。`
              : null}
          {!cloudEndpoint() && profileId
            ? '現在Cloud解析の接続先が設定されていないため、開始できません。'
            : ''}
        </AppText>
        {cloudLoadError ? <Notice text={cloudLoadError} error /> : null}
        <SectionLabel>盤面と操作</SectionLabel>
        <Group>
          <Row
            label="駒セット"
            value={PIECE_SETS[settings.pieceSet].name}
            onPress={() => router.push('/piece-sets')}
            testID="piece-sets-link"
          />
          <Row
            label="盤面の向き"
            value={settings.boardFlip ? '相手が手前' : '自分が手前'}
            onPress={() =>
              void choose('盤面の向き', [
                { label: '自分が手前', value: false },
                { label: '相手が手前', value: true },
              ]).then((value) => {
                if (value !== undefined) return update({ boardFlip: value });
              })
            }
          />
          <Row label="候補手の矢印">{toggle('showArrows')}</Row>
          <Row label="詰めバッジ">{toggle('showMateBadges')}</Row>
          <Row label="触覚フィードバック" last>
            {toggle('haptics')}
          </Row>
        </Group>
        <Group style={{ marginTop: 24 }}>
          <Row
            label="表示テーマ"
            value={{ system: 'システム', light: 'ライト', dark: 'ダーク' }[settings.theme]}
            onPress={() =>
              void choose('表示テーマ', [
                { label: 'システム', value: 'system' as const },
                { label: 'ライト', value: 'light' as const },
                { label: 'ダーク', value: 'dark' as const },
              ]).then((value) => {
                if (value !== undefined) return update({ theme: value });
              })
            }
          />
          <Row label="ライセンス" onPress={() => router.push('/licenses')} />
          <Row
            label="meeshogiについて"
            onPress={() =>
              Alert.alert(
                'meeshogi',
                '無料の端末内解析・棋譜管理・戦績管理。棋譜はこの端末に保存します。\n\nバージョン 0.1.0',
              )
            }
            last
          />
        </Group>
      </PageScroll>
    </SafeAreaView>
  );
}
