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
import { PositionAnalysis, Side, SIDE_LABELS } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { shareKif } from '@/platform/kif-files';
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
  toEvaluationChartValue,
  toEvaluationValue,
} from '@/ui/evaluation';
import { currentGameAnalysis, isCompatibleAnalysis } from '@/analysis/cache';

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
  const currentAnalysis =
    sfen &&
    isCompatibleAnalysis(focusedAnalysis, sfen, {
      nodes: Math.min(1000000, settings.analysisNodes * 5),
      multiPV: settings.multiPV,
    })
      ? focusedAnalysis
      : !branch
        ? mainlineAnalysis[ply]
        : null;
  const candidates =
    currentAnalysis?.candidates.filter((candidate) => validMoves.includes(candidate.usi)) ?? [];
  const currentEvaluation = toEvaluationValue(candidates[0]);
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
  const menu = async () => {
    if (!game) return;
    const action = await choose('棋譜の操作', [
      { label: game.favorite ? 'お気に入りを解除' : 'お気に入りに追加', value: 'favorite' },
      { label: 'KIFを書き出す', value: 'share' },
      { label: '対局情報を確認・修正', value: 'info' },
      { label: '盤面を反転', value: 'flip' },
    ]);
    try {
      if (action === 'favorite') await updateGame(id, { favorite: !game.favorite });
      if (action === 'share') await shareKif(game);
      if (action === 'info') router.push({ pathname: '/game-info/[id]', params: { id } });
      if (action === 'flip') setFlipped((value) => !value);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const proof = currentAnalysis?.mateProof;
  const proven = settings.showMateBadges && isDisplayableMateProof(proof, position?.turn);
  if (!game || !sfen)
    return (
      <EmptyState
        title="棋譜が見つかりません"
        message="一覧から別の棋譜を開いてください。"
        action="棋譜一覧へ"
        onAction={() => router.dismissTo('/')}
      />
    );
  const completed = mainlineAnalysis.filter(Boolean).length;
  const fullyAnalyzed = completed >= game.positions.length;
  const previousResults = Object.keys(game.analysis).length - completed;
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
          (currentEvaluation.kind === 'centipawn' && currentEvaluation.value < 0)
        ? theme.loss
        : theme.win;
  const statusLabel = branch
    ? focusBusy
      ? '分岐を解析中'
      : currentAnalysis
        ? '分岐の解析結果'
        : '分岐は未解析'
    : fullyAnalyzed
      ? '全局解析が完了しました'
      : job?.status === 'running'
        ? `解析中 ${completed} / ${job.total}局面`
        : job?.status === 'paused'
          ? `解析を停止中 ${completed} / ${job.total}局面`
          : job?.status === 'error'
            ? '解析を再開できます'
            : completed
              ? `${completed}局面を解析済み`
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
              candidates.length > 0 && currentAnalysis?.sfen === sfen ? 'analysis-ready' : undefined
            }
            style={[styles.evaluationSection, { borderColor: theme.border }]}
          >
            <View style={styles.evaluationHeader}>
              <View style={styles.evaluationMetric}>
                <AppText
                  selectable
                  accessibilityLabel={`先手視点の評価値 ${formatEvaluation(currentEvaluation)}`}
                  style={[styles.evaluationValue, { color: evaluationColor }]}
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
                    {focusBusy || (!branch && job?.status === 'running') ? (
                      <ActivityIndicator size="small" color={theme.win} />
                    ) : fullyAnalyzed && !branch ? (
                      <Icon name="check" size={13} color={theme.win} />
                    ) : null}
                    <AppText variant="small" tone="secondary" style={{ flexShrink: 1 }}>
                      {branch
                        ? focusBusy
                          ? '局面を解析中'
                          : '分岐の評価'
                        : focusBusy
                          ? '追加解析中'
                          : fullyAnalyzed
                            ? '全局解析済み'
                            : `解析 ${completed} / ${game.positions.length}`}
                    </AppText>
                  </View>
                )}
                {!branch && currentAnalysis === focusedAnalysis && currentAnalysis && (
                  <AppText variant="small" tone="accent">
                    追加解析の評価値
                  </AppText>
                )}
              </View>
            </View>
            {!branch && (
              <LineChart
                values={mainlineAnalysis.map((result) =>
                  toEvaluationChartValue(toEvaluationValue(result?.candidates[0])),
                )}
                valueLabels={mainlineAnalysis.map((result) => {
                  const evaluation = toEvaluationValue(result?.candidates[0]);
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
                  {focusBusy || (!branch && job?.status === 'running') ? (
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
                          : job?.status === 'running' && !branch
                            ? '候補手の解析を待っています'
                            : job?.status === 'paused' && !branch
                              ? '解析を停止しています'
                              : '候補手はまだありません'}
                    </AppText>
                    <AppText variant="small" tone="secondary">
                      {focusBusy || (!branch && job?.status === 'running')
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
            {!branch && previousResults > 0 && (
              <Notice
                text={`以前のモデル・解析条件の結果が${previousResults}局面あります。現在の設定で解析し直せます。`}
              />
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
            {!branch && currentAnalysis && currentAnalysis === focusedAnalysis && (
              <AppText variant="caption" tone="secondary" testID="focused-analysis-ready">
                この局面の追加解析結果を表示中
              </AppText>
            )}
            {job?.status === 'error' && (
              <Notice text={job.error ?? '解析に失敗しました。もう一度解析できます。'} error />
            )}
            {job?.status === 'running' && !branch && (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="全局解析の進捗"
                accessibilityValue={{ now: completed, min: 0, max: job.total }}
                style={[styles.progressTrack, { backgroundColor: theme.inset }]}
              >
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: theme.win,
                      width: `${job.total ? (completed / job.total) * 100 : 0}%`,
                    },
                  ]}
                />
              </View>
            )}
            <View style={styles.actionButtons}>
              {!branch &&
                (job?.status === 'running' ? (
                  <TextButton
                    label="解析を停止"
                    testID="analysis-stop"
                    onPress={stopAnalysis}
                    icon="pause"
                  />
                ) : (
                  <TextButton
                    label={fullyAnalyzed ? '解析済み' : completed ? '解析を再開' : '解析する'}
                    disabled={fullyAnalyzed}
                    testID="analysis-start"
                    onPress={() => void startAnalysis(id).catch((e) => setError(errorMessage(e)))}
                    icon={fullyAnalyzed ? 'check' : 'play'}
                  />
                ))}
              <TextButton
                testID="analysis-focus"
                label={focusBusy ? '追加解析中…' : 'この局面を深く解析'}
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
  actionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: 12,
  },
});
