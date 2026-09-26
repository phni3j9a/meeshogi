import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { applyUsi, boardView, legalMoves, moveLabel } from '@/domain';
import {
  ANALYSIS_METHOD_LABELS,
  ANALYSIS_METHODS,
  cloudProfileOf,
  PositionAnalysis,
  Side,
  SIDE_LABELS,
  type AnalysisMethod,
} from '@/domain/model';
import {
  CLOUD_PROFILE_LABELS,
  CLOUD_MAX_MOVES,
  isActiveAttempt,
  type CloudAttempt,
} from '@/cloud/contract';
import { cloudEndpoint } from '@/cloud/config';
import type { CloudPositionResult } from '@/cloud/results';
import { useAppStore } from '@/store/app-store';
import { shareKif } from '@/platform/kif-files';
import { shareComparisonExport } from '@/platform/comparison-files';
import { AppText, EmptyState, Icon, IconButton, Notice, TextButton } from '@/ui/primitives';
import { Playback, ShogiBoard } from '@/ui/board';
import { LineChart } from '@/ui/charts';
import { openingDescription } from '@/ui/game-row';
import { openMateSession } from '@/ui/mate-session';
import { useTheme } from '@/ui/theme';
import { errorMessage, useChoice } from '@/ui/use-choice';
import {
  formatEvaluation,
  isDisplayableMateProof,
  resolveDisplayEvaluation,
  toEvaluationChartValue,
  toEvaluationValue,
  type DisplayResult,
} from '@/ui/evaluation';
import { currentGameAnalysis, isCompatibleAnalysis } from '@/analysis/cache';
import { analysisJobProcessed, partialAnalysisMessage } from '@/store/analysis-job';

function latestAttempt(attempts: CloudAttempt[], profileId: 'free' | 'precision') {
  return attempts
    .filter((attempt) => attempt.profileId === profileId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function cloudStatusLabel(attempt: CloudAttempt): string {
  switch (attempt.status) {
    case 'requesting':
      return 'Cloud解析を開始しています';
    case 'queued':
      return 'Cloud解析の順番を待っています';
    case 'running':
      return `Cloud解析中・処理 ${attempt.serverNextPly} / ${attempt.totalPlies}局面`;
    case 'cancel-requested':
      return 'Cloud解析を取消しています';
    case 'completed':
      return attempt.validCount >= attempt.totalPlies
        ? 'Cloud解析が完了しました'
        : `Cloud解析が終了しました・有効 ${attempt.validCount} / ${attempt.totalPlies}局面`;
    case 'failed':
      return 'Cloud解析が失敗しました';
    case 'cancelled':
      return 'Cloud解析を取消しました';
    case 'error': {
      // A confirmed server outcome is shown together with the local
      // fetch/validation error and the count of saved valid results.
      const suffix = `・有効 ${attempt.validCount}/${attempt.totalPlies}局面`;
      if (attempt.serverStatus === 'cancelled') return `Cloud解析は取消済みです${suffix}`;
      if (attempt.serverStatus === 'failed') return `Cloud解析はサーバーで失敗しました${suffix}`;
      if (attempt.serverStatus === 'completed')
        return `Cloud解析はサーバーで終了しました${suffix}`;
      return 'Cloud解析を再開できます';
    }
  }
}

type Branch = { origin: number; positions: string[]; moves: string[]; cursor: number };

/** Advance through the first move, then show the legal replies without repeating the heading. */
function principalVariationLabel(sfen: string, moves: string[]): string {
  const labels: string[] = [];
  let position = sfen;
  for (const [index, move] of moves.slice(0, 3).entries()) {
    try {
      const next = applyUsi(position, move);
      if (index > 0) labels.push(moveLabel(position, move));
      position = next;
    } catch {
      break;
    }
  }
  return labels.join('  ') + (labels.length === 2 && moves.length > 3 ? ' …' : '');
}

export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = useAppStore((state) => state.games.find((item) => item.id === id));
  const settings = useAppStore((state) => state.settings);
  const analysisJob = useAppStore((state) => state.analysisJob);
  const setLastViewed = useAppStore((state) => state.setLastViewed);
  const startAnalysis = useAppStore((state) => state.startAnalysis);
  const stopAnalysis = useAppStore((state) => state.stopAnalysis);
  const analyzePosition = useAppStore((state) => state.analyzePosition);
  const updateGame = useAppStore((state) => state.updateGame);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const startCloudAnalysis = useAppStore((state) => state.startCloudAnalysis);
  const cancelCloudAnalysis = useAppStore((state) => state.cancelCloudAnalysis);
  const loadCloudResults = useAppStore((state) => state.loadCloudResults);
  const cloudAttempts = useAppStore((state) => state.cloudAttempts);
  const cloudLoadError = useAppStore((state) => state.cloudLoadError);
  const exportComparison = useAppStore((state) => state.exportComparison);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const choose = useChoice();
  const [ply, setPly] = useState(game?.lastViewedPly ?? 0);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState(0);
  const [flipped, setFlipped] = useState(settings.boardFlip);
  const [focusedAnalysis, setFocusedAnalysis] = useState<PositionAnalysis | null>(null);
  const [focusBusy, setFocusBusy] = useState(false);
  const [cloudStarting, setCloudStarting] = useState(false);
  const [error, setError] = useState('');
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const focusRequest = useRef(0);
  // The measured body excludes the native navigation bar. Reserve space for
  // player rails, evaluation, tabs, a candidate row, and the fixed playback bar.
  const boardMaxEdge = Math.max(
    260,
    Math.min(440, (rootHeight ?? windowHeight - 91) - insets.bottom - 427),
  );
  const sfen = branch ? branch.positions[branch.cursor] : game?.positions[ply];
  const validMoves = useMemo(() => (sfen ? legalMoves(sfen) : []), [sfen]);
  const position = useMemo(() => (sfen ? boardView(sfen) : null), [sfen]);
  const method = settings.analysisMethod;
  const profileId = cloudProfileOf(method);
  const gameAttempts = useMemo(
    () => cloudAttempts.filter((attempt) => attempt.gameId === id),
    [cloudAttempts, id],
  );
  const attempt = useMemo(
    () => (profileId ? latestAttempt(gameAttempts, profileId) : undefined),
    [gameAttempts, profileId],
  );
  const otherProfileActive = gameAttempts.find(
    (item) => item.profileId !== profileId && isActiveAttempt(item.status),
  );
  const runningElsewhere = useMemo(
    () =>
      cloudAttempts.find(
        (item) => item.gameId !== id && isActiveAttempt(item.status),
      ),
    [cloudAttempts, id],
  );
  const cloudRows = useAppStore((state) =>
    attempt ? state.cloudResults[attempt.attemptId] : undefined,
  );
  useEffect(() => {
    if (profileId && attempt) void loadCloudResults(id).catch(() => undefined);
  }, [profileId, attempt?.attemptId, id, loadCloudResults]);
  const cloudLine = useMemo(() => {
    const byPly = new Map<number, CloudPositionResult>();
    for (const row of cloudRows ?? []) byPly.set(row.ply, row);
    return byPly;
  }, [cloudRows]);
  const mainlineAnalysis = useMemo(
    () =>
      game
        ? currentGameAnalysis(game, {
            nodes: settings.analysisNodes,
            multiPV: settings.multiPV,
          })
        : [],
    [game?.positions, game?.analysis, settings.analysisNodes, settings.multiPV],
  );
  const focusedOk =
    !!sfen &&
    isCompatibleAnalysis(focusedAnalysis, sfen, {
      nodes: Math.min(1000000, settings.analysisNodes * 5),
      multiPV: settings.multiPV,
    });
  const currentAnalysis = focusedOk
    ? focusedAnalysis
    : !branch
      ? mainlineAnalysis[ply]
      : null;
  const mainlineResult: DisplayResult | null = branch
    ? null
    : method === 'sekirei'
      ? (mainlineAnalysis[ply] ?? null)
      : (cloudLine.get(ply) ?? null);
  const currentResult: DisplayResult | null = focusedOk
    ? focusedAnalysis
    : mainlineResult;
  const candidates =
    currentResult?.candidates
      ?.filter(
        (candidate): candidate is PositionAnalysis['candidates'][number] =>
          !!candidate && validMoves.includes(candidate.usi),
      ) ?? [];
  const currentEvaluation = resolveDisplayEvaluation(
    currentResult ? { ...currentResult, candidates } : currentResult,
  );
  const bottomSide: Side = flipped
    ? game?.mySide === 'white'
      ? 'black'
      : 'white'
    : (game?.mySide ?? 'black');
  const cursor = branch?.cursor ?? ply;
  const total = branch ? branch.moves.length : (game?.moves.length ?? 0);
  const job = analysisJob?.gameId === id ? analysisJob : null;
  const leaveBranch = () => {
    focusRequest.current++;
    setFocusBusy(false);
    setFocusedAnalysis(null);
    setBranch(null);
    setSelected(null);
    setPlaying(false);
    setError('');
  };
  usePreventRemove(!!branch || !!selected, () => {
    if (selected) setSelected(null);
    else leaveBranch();
  });
  useEffect(() => {
    if (game) void setLastViewed(id, game.lastViewedPly).catch((e) => setError(errorMessage(e)));
  }, [id, setLastViewed]);
  useFocusEffect(
    useCallback(
      () => () => {
        setPlaying(false);
      },
      [],
    ),
  );
  useEffect(() => {
    focusRequest.current++;
    setFocusBusy(false);
    setSelected(null);
    setFocusedAnalysis((previous) => (previous?.sfen === sfen ? previous : null));
    setError('');
  }, [sfen, settings.analysisNodes, settings.multiPV]);
  const go = (next: number, stopPlaying = true) => {
    const bounded = Math.max(0, Math.min(total, next));
    if (stopPlaying) setPlaying(false);
    setSelected(null);
    if (branch) setBranch({ ...branch, cursor: bounded });
    else {
      setPly(bounded);
      void setLastViewed(id, bounded).catch((e) => setError(errorMessage(e)));
    }
    if (settings.haptics && stopPlaying) void Haptics.selectionAsync().catch(() => undefined);
  };
  useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => go(cursor + 1, false), 850);
    return () => clearTimeout(timer);
  }, [playing, cursor, total, branch]);
  const focus = async (target: string) => {
    const request = ++focusRequest.current;
    setFocusBusy(true);
    setError('');
    try {
      const result = await analyzePosition(target);
      if (request === focusRequest.current && result.sfen === target) setFocusedAnalysis(result);
    } catch (e) {
      if (request === focusRequest.current) setError(errorMessage(e));
    } finally {
      if (request === focusRequest.current) setFocusBusy(false);
    }
  };
  useEffect(() => {
    if (branch && sfen) void focus(sfen);
    return () => {
      focusRequest.current++;
    };
  }, [branch?.positions[branch.cursor]]);
  const commitMove = (usi: string) => {
    if (!sfen || !game) return;
    try {
      const next = applyUsi(sfen, usi);
      setSelected(null);
      setPlaying(false);
      if (!branch && game.moves[ply]?.usi === usi) {
        go(ply + 1);
        return;
      }
      if (branch)
        setBranch({
          ...branch,
          positions: [...branch.positions.slice(0, branch.cursor + 1), next],
          moves: [...branch.moves.slice(0, branch.cursor), usi],
          cursor: branch.cursor + 1,
        });
      else setBranch({ origin: ply, positions: [sfen, next], moves: [usi], cursor: 1 });
      if (settings.haptics)
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const selectSquare = (square: string) => {
    if (!position) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (selected) {
      const options = validMoves.filter(
        (move) => move.startsWith(selected) && move.slice(2, 4) === square,
      );
      if (options.length === 1) {
        commitMove(options[0]);
        return;
      }
      if (options.length > 1) {
        Alert.alert('駒を成りますか？', '', [
          { text: '成る', onPress: () => commitMove(options.find((move) => move.endsWith('+'))!) },
          {
            text: '成らない',
            onPress: () => commitMove(options.find((move) => !move.endsWith('+'))!),
          },
          { text: 'キャンセル', style: 'cancel' },
        ]);
        return;
      }
    }
    if (validMoves.some((move) => move.startsWith(square))) {
      setSelected(square);
      setError('');
    } else if (selected) setError('印のあるマスに移動できます。別の駒を選ぶこともできます。');
  };
  const previewCandidate = (moves: string[]) => {
    if (!sfen) return;
    try {
      const positions = [sfen];
      moves.forEach((move) => positions.push(applyUsi(positions[positions.length - 1], move)));
      if (branch)
        setBranch({
          ...branch,
          positions: [...branch.positions.slice(0, branch.cursor), ...positions],
          moves: [...branch.moves.slice(0, branch.cursor), ...moves],
          cursor: branch.cursor + Math.min(1, moves.length),
        });
      else setBranch({ origin: ply, positions, moves, cursor: Math.min(1, moves.length) });
      setSelected(null);
      setPlaying(false);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  // Development-only comparison export (Plan §5). Hidden in release builds
  // unless EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT=1 was set at build time.
  const canExportComparison =
    __DEV__ || process.env.EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT === '1';
  const menu = async () => {
    if (!game) return;
    const action = await choose('棋譜の操作', [
      { label: game.favorite ? 'お気に入りを解除' : 'お気に入りに追加', value: 'favorite' },
      { label: 'KIFを書き出す', value: 'share' },
      ...(canExportComparison
        ? [{ label: '比較レポートを書き出す（開発用）', value: 'comparison' }]
        : []),
      { label: '対局情報を確認・修正', value: 'info' },
      { label: '盤面を反転', value: 'flip' },
    ]);
    try {
      if (action === 'favorite') await updateGame(id, { favorite: !game.favorite });
      if (action === 'share') await shareKif(game);
      if (action === 'comparison') {
        const doc = await exportComparison(id);
        const path = await shareComparisonExport(id, doc);
        Alert.alert('比較レポート', `書き出しました:\n${path}`);
      }
      if (action === 'info') router.push({ pathname: '/game-info/[id]', params: { id } });
      if (action === 'flip') setFlipped((value) => !value);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const proof = currentAnalysis?.mateProof;
  // Mate badges are only ever produced from proven Sekirei mateProof results.
  // Under a Cloud method nothing on screen is a proof, so badges stay hidden.
  const proven =
    settings.showMateBadges &&
    method === 'sekirei' &&
    isDisplayableMateProof(proof, position?.turn);
  if (!game || !sfen)
    return (
      <EmptyState
        title="棋譜が見つかりません"
        message="一覧から別の棋譜を開いてください。"
        action="棋譜一覧へ"
        onAction={() => router.dismissTo('/')}
      />
    );
  const lineResults: (DisplayResult | null)[] =
    method === 'sekirei'
      ? mainlineAnalysis
      : game.positions.map((_, index) => cloudLine.get(index) ?? null);
  const completed =
    method === 'sekirei'
      ? mainlineAnalysis.filter(Boolean).length
      : (attempt?.validCount ?? 0);
  const fullyAnalyzed =
    method === 'sekirei'
      ? completed >= game.positions.length
      : !!attempt &&
        !isActiveAttempt(attempt.status) &&
        attempt.status === 'completed' &&
        attempt.validCount >= attempt.totalPlies;
  const previousResults =
    method === 'sekirei' ? Object.keys(game.analysis).length - completed : 0;
  const processed = job ? analysisJobProcessed(job) : completed;
  const cloudProcessed = attempt ? Math.max(attempt.serverNextPly, attempt.receivedCount) : 0;
  const partial = job?.status === 'partial';
  const lastMove = branch
    ? branch.cursor > 0
      ? branch.moves[branch.cursor - 1]
      : game.moves[branch.origin - 1]?.usi
    : game.moves[ply - 1]?.usi;
  const mainlineMoveLabel = (movePly: number) =>
    movePly > 0 ? moveLabel(game.positions[movePly - 1], game.moves[movePly - 1].usi) : '初期局面';
  const currentMoveLabel = branch
    ? branch.cursor > 0
      ? moveLabel(branch.positions[branch.cursor - 1], branch.moves[branch.cursor - 1])
      : mainlineMoveLabel(branch.origin)
    : mainlineMoveLabel(ply);
  const evaluationColor =
    currentEvaluation.kind === 'missing'
      ? theme.muted
      : currentEvaluation.kind === 'white-mate' ||
          ((currentEvaluation.kind === 'centipawn' || currentEvaluation.kind === 'checkmate') &&
            currentEvaluation.value < 0)
        ? theme.loss
        : theme.win;
  const statusLabel = branch
    ? focusBusy
      ? '分岐を解析中'
      : currentResult
        ? method === 'sekirei'
          ? '分岐の解析結果'
          : '分岐の解析結果（ローカル・Sekirei）'
        : '分岐は未解析'
    : profileId
      ? attempt
        ? cloudStatusLabel(attempt)
        : 'この棋譜はCloud未解析です'
      : partial
        ? '解析処理が終了しました'
        : fullyAnalyzed
          ? '全局解析が完了しました'
          : job?.status === 'running'
            ? `解析中 ${processed} / ${job.total}局面`
            : job?.status === 'paused'
              ? `解析を停止中 ${processed} / ${job.total}局面`
              : job?.status === 'error'
                ? '解析を再開できます'
                : completed
                  ? `解析済み ${completed} / ${game.positions.length}局面`
                  : 'この棋譜は未解析です';
  return (
    <View
      style={{ flex: 1, backgroundColor: theme.background, paddingBottom: insets.bottom }}
      testID="game-screen"
      onLayout={({ nativeEvent }) => setRootHeight(nativeEvent.layout.height)}
    >
      <Stack.Screen
        options={{
          title: branch ? '分岐検討' : '棋譜解析',
          headerTitleAlign: 'center',
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <AppText maxFontSizeMultiplier={1.1} style={styles.headerName}>
                {branch ? '分岐検討' : '棋譜解析'}
              </AppText>
              <AppText
                variant="small"
                tone="secondary"
                numberOfLines={1}
                maxFontSizeMultiplier={1.1}
                style={styles.headerSubtitle}
              >
                {branch ? `${branch.origin}手目から分岐` : openingDescription(game)}
              </AppText>
            </View>
          ),
          headerLeft: branch
            ? () => <IconButton label="本譜に戻る" name="previous" onPress={leaveBranch} />
            : undefined,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="盤面を反転"
                testID="board-flip"
                onPress={() => setFlipped((value) => !value)}
                style={({ pressed }) => [styles.headerIcon, { opacity: pressed ? 0.5 : 1 }]}
              >
                <Icon name="flip" size={20} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="棋譜の操作"
                onPress={() => void menu()}
                style={({ pressed }) => [styles.headerIcon, { opacity: pressed ? 0.5 : 1 }]}
              >
                <Icon name="more" />
              </Pressable>
            </View>
          ),
        }}
      />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.content}>
          {branch && (
            <View style={[styles.branchBanner, { backgroundColor: theme.accentSoft }]}>
              <AppText variant="caption" tone="accent" style={{ flex: 1 }}>
                {branch.cursor === 0 ? '分岐の開始局面' : `本譜から ${branch.cursor}手進行`}
              </AppText>
              <TextButton label="本譜に戻る" icon="previous" onPress={leaveBranch} />
            </View>
          )}
          <ShogiBoard
            sfen={sfen}
            maxEdge={boardMaxEdge}
            bottomSide={bottomSide}
            names={{ black: game.blackName, white: game.whiteName }}
            lastMove={lastMove}
            selected={selected}
            targets={
              selected
                ? validMoves
                    .filter((move) => move.startsWith(selected))
                    .map((move) => move.slice(2, 4))
                : []
            }
            onSquare={selectSquare}
            onHand={(piece) => {
              const key = `${piece}*`;
              setSelected(selected === key ? null : key);
              setError('');
            }}
            arrow={settings.showArrows && !selected ? candidates[0]?.usi : undefined}
          />
          {error ? (
            <Notice text={error} error action="閉じる" onAction={() => setError('')} />
          ) : null}
          <View
            testID={
              candidates.length > 0 && currentResult?.sfen === sfen ? 'analysis-ready' : undefined
            }
            style={[styles.evaluationSection, { borderColor: theme.border }]}
          >
            <View style={styles.evaluationHeader}>
              <View style={styles.evaluationMetric}>
                <AppText
                  selectable
                  testID="current-evaluation"
                  accessibilityLabel={`先手視点の評価値 ${formatEvaluation(currentEvaluation)}`}
                  style={[
                    styles.evaluationValue,
                    { color: evaluationColor },
                    currentEvaluation.kind === 'checkmate' && {
                      fontSize: 17,
                      lineHeight: 24,
                      flexShrink: 1,
                    },
                  ]}
                >
                  {formatEvaluation(currentEvaluation)}
                </AppText>
                <AppText variant="small" tone="secondary">
                  先手視点
                </AppText>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4, flexShrink: 1 }}>
                {proven && proof ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      const session = openMateSession({
                        sfen,
                        proof,
                        origin: branch
                          ? `${branch.origin}手目からの分岐・${branch.cursor}手`
                          : `${ply}手目の局面`,
                        bottomSide,
                      });
                      setPlaying(false);
                      router.push({ pathname: '/mate', params: { session } });
                    }}
                    style={[styles.mateBadge, { backgroundColor: theme.accentSoft }]}
                  >
                    <AppText variant="caption" tone="accent" style={{ fontWeight: '600' }}>
                      {SIDE_LABELS[proof.side]}・{proof.plies}手詰め ›
                    </AppText>
                  </Pressable>
                ) : (
                  <View style={styles.inline}>
                    {focusBusy ||
                    (!branch &&
                      (job?.status === 'running' ||
                        (attempt ? isActiveAttempt(attempt.status) : false))) ? (
                      <ActivityIndicator size="small" color={theme.win} />
                    ) : fullyAnalyzed && !branch ? (
                      <Icon name="check" size={13} color={theme.win} />
                    ) : null}
                    <AppText variant="small" tone="secondary" style={{ flexShrink: 1 }}>
                      {branch
                        ? focusBusy
                          ? '局面を解析中'
                          : method === 'sekirei'
                            ? '分岐の評価'
                            : '分岐の評価・ローカル'
                        : focusBusy
                          ? '追加解析中'
                          : fullyAnalyzed
                            ? '全局解析済み'
                            : `解析 ${completed} / ${game.positions.length}`}
                    </AppText>
                  </View>
                )}
                {!branch && currentResult === focusedAnalysis && focusedAnalysis && (
                  <AppText variant="small" tone="accent">
                    {method === 'sekirei'
                      ? '追加解析の評価値'
                      : 'ローカル解析（Sekirei）の評価値'}
                  </AppText>
                )}
              </View>
            </View>
            {!branch && (
              <LineChart
                values={lineResults.map((result) =>
                  toEvaluationChartValue(resolveDisplayEvaluation(result)),
                )}
                valueLabels={lineResults.map((result) => {
                  const evaluation = resolveDisplayEvaluation(result);
                  return evaluation.kind === 'missing' ? '未解析' : formatEvaluation(evaluation);
                })}
                selected={ply}
                onSelect={(next) => go(next)}
                onScrubStart={() => setPlaying(false)}
                height={74}
              />
            )}
            {branch && (
              <AppText variant="small" tone="secondary">
                {branch.origin + branch.cursor}手目 · 分岐の評価値
              </AppText>
            )}
          </View>
          {branch && (
            <View style={{ gap: 8, marginBottom: 16 }}>
              <AppText variant="caption" style={{ fontWeight: '600' }}>
                分岐の手順
              </AppText>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 6 }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: branch.cursor === 0 }}
                  onPress={() => go(0)}
                  style={[
                    styles.variationMove,
                    {
                      borderColor: branch.cursor === 0 ? theme.accent : theme.border,
                      backgroundColor: branch.cursor === 0 ? theme.accentSoft : theme.surface,
                    },
                  ]}
                >
                  <AppText variant="caption">開始局面</AppText>
                </Pressable>
                {branch.moves.map((move, index) => (
                  <Pressable
                    key={`${index}-${move}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: index + 1 === branch.cursor }}
                    onPress={() => go(index + 1)}
                    style={[
                      styles.variationMove,
                      {
                        borderColor: index + 1 === branch.cursor ? theme.accent : theme.border,
                        backgroundColor:
                          index + 1 === branch.cursor ? theme.accentSoft : theme.surface,
                      },
                    ]}
                  >
                    <AppText variant="caption">
                      {branch.origin + index + 1}　{moveLabel(branch.positions[index], move)}
                    </AppText>
                  </Pressable>
                ))}
              </ScrollView>
              <AppText variant="small" tone="secondary">
                この分岐は保存されません。本譜と戦績は変わりません。
              </AppText>
            </View>
          )}
          {!branch && (
            <View style={[styles.tabs, { borderColor: theme.border }]}>
              {['候補手', '棋譜'].map((label, index) => (
                <Pressable
                  key={label}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === index }}
                  testID={index === 0 ? 'analysis-tab-candidates' : 'analysis-tab-record'}
                  onPress={() => setTab(index)}
                  style={styles.tab}
                >
                  <AppText
                    variant="caption"
                    style={{
                      fontWeight: tab === index ? '700' : '400',
                      color: tab === index ? theme.text : theme.secondary,
                    }}
                  >
                    {label}
                  </AppText>
                  {tab === index && (
                    <View style={[styles.tabIndicator, { backgroundColor: theme.win }]} />
                  )}
                </Pressable>
              ))}
            </View>
          )}
          {tab === 0 || branch ? (
            <View style={{ backgroundColor: theme.surface }}>
              {candidates.map((candidate, index) => {
                const pv = principalVariationLabel(
                  sfen,
                  candidate.pv.length ? candidate.pv : [candidate.usi],
                );
                return (
                  <Pressable
                    key={candidate.usi}
                    testID={`candidate-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`候補${index + 1}、${moveLabel(sfen, candidate.usi)}、評価値${formatEvaluation(toEvaluationValue(candidate))}、タップして分岐を検討`}
                    onPress={() =>
                      previewCandidate(candidate.pv.length ? candidate.pv : [candidate.usi])
                    }
                    style={({ pressed }) => [
                      styles.candidateRow,
                      {
                        borderBottomColor: theme.border,
                        backgroundColor: pressed ? theme.inset : 'transparent',
                      },
                    ]}
                  >
                    {index === 0 && (
                      <View style={[styles.bestCandidateMark, { backgroundColor: theme.win }]} />
                    )}
                    <View style={[styles.rank, { width: 44 * fontScale }]}>
                      <AppText
                        variant="small"
                        numberOfLines={1}
                        style={{
                          color: index === 0 ? theme.win : theme.secondary,
                          fontWeight: index === 0 ? '600' : '400',
                        }}
                      >
                        {['第一候補', '第二候補', '第三候補'][index] ?? `第${index + 1}候補`}
                      </AppText>
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      <View style={styles.candidateHeading}>
                        <AppText variant="headline" style={{ flexShrink: 1 }}>
                          {moveLabel(sfen, candidate.usi)}
                        </AppText>
                        <AppText
                          variant="headline"
                          style={{
                            fontSize: 16,
                            lineHeight: 24,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {formatEvaluation(toEvaluationValue(candidate))}
                        </AppText>
                      </View>
                      <AppText variant="small" tone="secondary" numberOfLines={2}>
                        {pv || '盤上で検討する'}
                      </AppText>
                    </View>
                    <Icon name="next" size={13} color={theme.muted} />
                  </Pressable>
                );
              })}
              {!candidates.length && (
                <View style={[styles.emptyCandidates, { backgroundColor: theme.surface }]}>
                  {focusBusy ||
                  (!branch &&
                    (job?.status === 'running' ||
                      (attempt ? isActiveAttempt(attempt.status) : false))) ? (
                    <ActivityIndicator size="small" color={theme.win} />
                  ) : (
                    <Icon
                      name={!validMoves.length ? 'check' : 'stats'}
                      size={22}
                      color={theme.muted}
                    />
                  )}
                  <View style={{ flex: 1, gap: 3 }}>
                    <AppText variant="caption" style={{ fontWeight: '600' }}>
                      {focusBusy
                        ? 'この局面を解析しています'
                        : !validMoves.length
                          ? 'この局面には合法手がありません'
                          : !branch && job?.status === 'running'
                            ? '候補手の解析を待っています'
                            : !branch && attempt && isActiveAttempt(attempt.status)
                              ? 'Cloud解析の候補手を待っています'
                              : !branch && job?.status === 'paused'
                                ? '解析を停止しています'
                                : '候補手はまだありません'}
                    </AppText>
                    <AppText variant="small" tone="secondary">
                      {focusBusy ||
                      (!branch &&
                        (job?.status === 'running' ||
                          (attempt ? isActiveAttempt(attempt.status) : false)))
                        ? '解析中も盤面を動かして検討できます。'
                        : !validMoves.length
                          ? '手を戻して、気になる局面を振り返れます。'
                          : '下の解析ボタンから候補手を確認できます。'}
                    </AppText>
                  </View>
                </View>
              )}
            </View>
          ) : (
            <View style={[styles.movesCard, { backgroundColor: theme.surface }]}>
              {game.moves
                .slice(Math.max(0, ply - 3), Math.min(game.moves.length, ply + 5))
                .map((move, index) => {
                  const movePly = Math.max(0, ply - 3) + index + 1;
                  return (
                    <Pressable
                      key={movePly}
                      onPress={() => go(movePly)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: movePly === ply }}
                      style={[
                        styles.recordMove,
                        { backgroundColor: movePly === ply ? theme.winSoft : 'transparent' },
                      ]}
                    >
                      <AppText
                        variant="caption"
                        tone="secondary"
                        style={{ minWidth: 24, fontVariant: ['tabular-nums'] }}
                      >
                        {movePly}
                      </AppText>
                      <AppText style={{ flex: 1, fontWeight: movePly === ply ? '600' : '400' }}>
                        {mainlineMoveLabel(movePly)}
                      </AppText>
                      <AppText variant="small" tone="secondary">
                        {Math.floor(move.elapsedMs / 1000)}秒
                      </AppText>
                    </Pressable>
                  );
                })}
            </View>
          )}
          <View style={[styles.analysisActions, { borderColor: theme.border }]}>
            {!branch && partial && job && <Notice text={partialAnalysisMessage(job)} />}
            {!branch && previousResults > 0 && (
              <Notice
                text={`以前のモデル・解析条件の結果が${previousResults}局面あります。現在の設定で解析し直せます。`}
              />
            )}
            {!branch && cloudLoadError && <Notice text={cloudLoadError} error />}
            {!branch && profileId && !cloudEndpoint() && (
              <Notice
                text="Cloud解析の接続先が設定されていないため、この方式では解析できません。端末内（Sekirei）をお使いください。"
              />
            )}
            {!branch &&
              profileId &&
              game.moves.length > CLOUD_MAX_MOVES && (
                <Notice
                  text={`Cloud解析は${CLOUD_MAX_MOVES}手までの棋譜に対応しています。この棋譜は${game.moves.length}手のため、端末内（Sekirei）をお使いください。`}
                />
              )}
            {!branch && otherProfileActive && (
              <Notice
                text={`${CLOUD_PROFILE_LABELS[otherProfileActive.profileId]}の解析をサーバーで実行中です（処理 ${otherProfileActive.serverNextPly} / ${otherProfileActive.totalPlies}局面）。`}
                action="取消する"
                onAction={() =>
                  void cancelCloudAnalysis(otherProfileActive.attemptId).catch((e) =>
                    setError(errorMessage(e)),
                  )
                }
              />
            )}
            {!branch &&
              profileId &&
              runningElsewhere &&
              !(attempt && isActiveAttempt(attempt.status)) &&
              !otherProfileActive && (
                <Notice text="別の棋譜のCloud解析を実行中です。その解析の終了または取消を待ってから開始できます。" />
              )}
            {!branch && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="解析方式を変更"
                testID="analysis-method"
                onPress={() =>
                  void choose('解析方法', [
                    ...ANALYSIS_METHODS.map((value) => ({
                      label: ANALYSIS_METHOD_LABELS[value],
                      value,
                    })),
                  ]).then((value: AnalysisMethod | undefined) => {
                    if (value !== undefined && value !== method)
                      void updateSettings({ analysisMethod: value }).catch((e) =>
                        setError(errorMessage(e)),
                      );
                  })
                }
                style={({ pressed }) => [
                  styles.methodRow,
                  { borderColor: theme.border, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <AppText variant="caption" tone="secondary">
                  解析方式
                </AppText>
                <AppText variant="caption" style={{ fontWeight: '600' }}>
                  {ANALYSIS_METHOD_LABELS[method]}
                </AppText>
                <Icon name="next" size={13} color={theme.muted} />
              </Pressable>
            )}
            <View style={styles.inline}>
              {fullyAnalyzed && !branch && <Icon name="check" size={14} color={theme.win} />}
              <AppText
                variant="caption"
                tone="secondary"
                testID="analysis-status"
                style={{ flex: 1 }}
              >
                {statusLabel}
              </AppText>
            </View>
            {!branch && currentResult === focusedAnalysis && focusedAnalysis && (
              <AppText variant="caption" tone="secondary" testID="focused-analysis-ready">
                {method === 'sekirei'
                  ? 'この局面の追加解析結果を表示中'
                  : 'この局面のローカル解析（Sekirei）結果を表示中'}
              </AppText>
            )}
            {job?.status === 'error' && (
              <Notice text={job.error ?? '解析に失敗しました。もう一度解析できます。'} error />
            )}
            {!branch && attempt?.status === 'error' && (
              <Notice
                text={attempt.failureMessage ?? attempt.lastError ?? 'Cloud解析に失敗しました。'}
                error
              />
            )}
            {!branch && attempt?.status === 'failed' && (
              <Notice
                text={attempt.failureMessage ?? 'Cloud解析が失敗しました。'}
                error
              />
            )}
            {job?.status === 'running' && !branch && (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="全局解析の進捗"
                accessibilityValue={{ now: processed, min: 0, max: job.total }}
                style={[styles.progressTrack, { backgroundColor: theme.inset }]}
              >
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: theme.win,
                      width: `${job.total ? (processed / job.total) * 100 : 0}%`,
                    },
                  ]}
                />
              </View>
            )}
            {!branch && attempt && isActiveAttempt(attempt.status) && (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Cloud解析の進捗"
                accessibilityValue={{ now: cloudProcessed, min: 0, max: attempt.totalPlies }}
                style={[styles.progressTrack, { backgroundColor: theme.inset }]}
              >
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: theme.accent,
                      width: `${attempt.totalPlies ? (cloudProcessed / attempt.totalPlies) * 100 : 0}%`,
                    },
                  ]}
                />
              </View>
            )}
            <View style={styles.actionButtons}>
              {!branch &&
                (profileId ? (
                  attempt && isActiveAttempt(attempt.status) ? (
                    <TextButton
                      label="Cloud解析を取消"
                      testID="cloud-cancel"
                      onPress={() =>
                        void cancelCloudAnalysis(attempt.attemptId).catch((e) =>
                          setError(errorMessage(e)),
                        )
                      }
                      icon="pause"
                    />
                  ) : (
                    <>
                      <TextButton
                        label={
                          fullyAnalyzed
                            ? 'Cloud解析済み'
                            : attempt
                              ? 'Cloud解析を再試行'
                              : 'Cloud解析を開始'
                        }
                        disabled={
                          cloudStarting ||
                          fullyAnalyzed ||
                          !cloudEndpoint() ||
                          game.moves.length > CLOUD_MAX_MOVES ||
                          !!runningElsewhere ||
                          !!otherProfileActive
                        }
                        testID="cloud-start"
                        onPress={() => {
                          // Block double-taps while the async start prepares
                          // (credential issuance + attempt write).
                          setCloudStarting(true);
                          void startCloudAnalysis(id)
                            .catch((e) => setError(errorMessage(e)))
                            .finally(() => setCloudStarting(false));
                        }}
                        icon={fullyAnalyzed ? 'check' : 'play'}
                      />
                      {attempt?.status === 'error' &&
                      (attempt.jobId || attempt.submitAttempted) ? (
                        <TextButton
                          label="中断した解析を取消"
                          testID="cloud-cancel-error"
                          onPress={() =>
                            void cancelCloudAnalysis(attempt.attemptId).catch((e) =>
                              setError(errorMessage(e)),
                            )
                          }
                          icon="pause"
                        />
                      ) : null}
                    </>
                  )
                ) : job?.status === 'running' ? (
                  <TextButton
                    label="解析を停止"
                    testID="analysis-stop"
                    onPress={stopAnalysis}
                    icon="pause"
                  />
                ) : (
                  <TextButton
                    label={
                      fullyAnalyzed
                        ? '解析済み'
                        : completed || (job?.budgetShortfallPlies.length ?? 0) > 0
                          ? '解析を再開'
                          : '解析する'
                    }
                    disabled={fullyAnalyzed}
                    testID="analysis-start"
                    onPress={() => void startAnalysis(id).catch((e) => setError(errorMessage(e)))}
                    icon={fullyAnalyzed ? 'check' : 'play'}
                  />
                ))}
              <TextButton
                testID="analysis-focus"
                label={
                  focusBusy
                    ? '追加解析中…'
                    : method === 'sekirei'
                      ? 'この局面を深く解析'
                      : 'この局面を深く解析（ローカル・Sekirei）'
                }
                onPress={() => void focus(sfen)}
                disabled={focusBusy}
              />
            </View>
          </View>
        </View>
      </ScrollView>
      <Playback
        ply={cursor}
        total={total}
        playing={playing}
        onChange={(next) => go(next)}
        onPlay={() => {
          if (cursor >= total) go(0, false);
          setPlaying((value) => !value);
        }}
        label={branch ? `${branch.origin + branch.cursor}手目・分岐${branch.cursor}手` : undefined}
        moveLabel={currentMoveLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { alignItems: 'center', maxWidth: 160 },
  headerName: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  headerSubtitle: { fontSize: 11, lineHeight: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 12, alignItems: 'center' },
  content: { width: '100%', maxWidth: 500 },
  branchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    marginBottom: 2,
  },
  evaluationSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    marginTop: 2,
    paddingBottom: 2,
    gap: 2,
  },
  evaluationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    minHeight: 32,
  },
  evaluationMetric: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flex: 1,
    gap: 8,
    minWidth: 112,
  },
  evaluationValue: {
    fontWeight: '700',
    fontSize: 26,
    lineHeight: 32,
    fontVariant: ['tabular-nums'],
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mateBadge: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  variationMove: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
  },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { minHeight: 44, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  tabIndicator: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: -0.5,
    height: 2,
    borderRadius: 1,
  },
  candidateRow: {
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bestCandidateMark: {
    position: 'absolute',
    top: 12,
    bottom: 12,
    left: 0,
    width: 3,
    borderRadius: 2,
  },
  rank: { width: 44, justifyContent: 'center' },
  candidateHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: 8,
  },
  emptyCandidates: {
    minHeight: 72,
    paddingHorizontal: 10,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  movesCard: { paddingVertical: 4 },
  recordMove: {
    flexDirection: 'row',
    minHeight: 44,
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  analysisActions: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  progressTrack: { height: 3, borderRadius: 3, marginVertical: 6, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 3 },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    marginBottom: 4,
  },
  actionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: 12,
  },
});
