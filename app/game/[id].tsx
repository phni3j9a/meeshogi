import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { applyUsi, boardView, legalMoves, moveLabel } from '@/domain';
import { PositionAnalysis, Side, SIDE_LABELS } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { shareKif } from '@/platform/kif-files';
import {
  AppText,
  EmptyState,
  Icon,
  IconButton,
  Notice,
  Segment,
  TextButton,
} from '@/ui/primitives';
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

/** Render only the legal prefix of the actual engine line, in board notation. */
function principalVariationLabel(sfen: string, moves: string[]): string {
  const labels: string[] = [];
  let position = sfen;
  for (const move of moves.slice(0, 3)) {
    try {
      const next = applyUsi(position, move);
      labels.push(moveLabel(position, move));
      position = next;
    } catch {
      break;
    }
  }
  return labels.join('  ');
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
  const focusRequest = useRef(0);
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
  const currentMoveLabel = branch
    ? branch.cursor > 0
      ? moveLabel(branch.positions[branch.cursor - 1], branch.moves[branch.cursor - 1])
      : (game.moves[branch.origin - 1]?.label ?? '初期局面')
    : (game.moves[ply - 1]?.label ?? '初期局面');
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
    >
      <Stack.Screen
        options={{
          title: branch ? '分岐検討' : '棋譜解析',
          headerLeft: branch
            ? () => <IconButton label="本譜に戻る" name="previous" onPress={leaveBranch} />
            : undefined,
          headerRight: () => (
            <IconButton name="more" label="棋譜の操作" onPress={() => void menu()} />
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.content}>
          <View style={styles.metadata}>
            <View
              style={[styles.mode, { backgroundColor: branch ? theme.accentSoft : theme.winSoft }]}
            >
              {branch && <Icon name="branch" size={13} />}
              <AppText
                variant="small"
                tone={branch ? 'accent' : 'win'}
                style={{ fontWeight: '600' }}
              >
                {branch ? '分岐' : '本譜'}
              </AppText>
            </View>
            <AppText variant="caption" tone="secondary" numberOfLines={2} style={{ flex: 1 }}>
              {branch ? `${branch.origin}手目から分岐` : openingDescription(game)}
            </AppText>
            <IconButton
              name="flip"
              label="盤面を反転"
              testID="board-flip"
              size={20}
              onPress={() => setFlipped((value) => !value)}
            />
          </View>
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
          {error ? <Notice text={error} error action="閉じる" onAction={() => setError('')} /> : null}
          <View
            testID={
              candidates.length > 0 && currentAnalysis?.sfen === sfen ? 'analysis-ready' : undefined
            }
            style={[
              styles.evaluationCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            <View style={styles.evaluationHeader}>
              <View style={{ flex: 1, minWidth: 100 }}>
                <AppText variant="small" tone="secondary">
                  評価値 · 先手視点
                </AppText>
                <AppText
                  selectable
                  accessibilityLabel={`先手視点の評価値 ${formatEvaluation(currentEvaluation)}`}
                  style={[styles.evaluationValue, { color: evaluationColor }]}
                >
                  {formatEvaluation(currentEvaluation)}
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
                    {(focusBusy || (!branch && job?.status === 'running')) && (
                      <ActivityIndicator size="small" color={theme.win} />
                    )}
                    <AppText variant="small" tone="secondary" style={{ flexShrink: 1 }}>
                      {branch
                        ? focusBusy
                          ? '局面を解析中'
                          : '分岐の評価'
                        : focusBusy
                          ? '追加解析中'
                          : `全局解析 ${completed} / ${game.positions.length}`}
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
                selected={ply}
                onSelect={(next) => go(next)}
                height={96}
              />
            )}
            {branch && (
              <AppText variant="small" tone="secondary">
                {branch.origin + branch.cursor}手目の局面 · 評価は盤面の向きによらず先手視点
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
          {!branch && <Segment labels={['候補手', '棋譜']} selected={tab} onChange={setTab} />}
          {tab === 0 || branch ? (
            <View style={{ gap: 8, paddingTop: 8 }}>
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
                      styles.candidateCard,
                      {
                        borderColor: index === 0 ? theme.win : theme.border,
                        backgroundColor: pressed ? theme.inset : theme.surface,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.rank,
                        { backgroundColor: index === 0 ? theme.winSoft : theme.inset },
                      ]}
                    >
                      <AppText
                        variant="caption"
                        style={{
                          color: index === 0 ? theme.win : theme.secondary,
                          fontWeight: '700',
                        }}
                      >
                        {index + 1}
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
                            color: index === 0 ? theme.win : theme.text,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {formatEvaluation(toEvaluationValue(candidate))}
                        </AppText>
                      </View>
                      <AppText variant="small" tone="secondary" numberOfLines={2}>
                        {pv ? `読み筋  ${pv}` : 'タップして盤上で検討'}
                      </AppText>
                    </View>
                    <Icon name="next" size={13} color={theme.muted} />
                  </Pressable>
                );
              })}
              {!candidates.length && (
                <View
                  style={[
                    styles.emptyCandidates,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                >
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
            <View
              style={[
                styles.movesCard,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <AppText
                variant="small"
                tone="secondary"
                style={{ paddingHorizontal: 10, paddingBottom: 8 }}
              >
                {ply === 0 ? '初期局面' : `${ply}手目 ${game.moves[ply - 1].label}`}
              </AppText>
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
                        {move.label}
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
  scrollContent: { paddingHorizontal: 12, paddingTop: 0, paddingBottom: 16, alignItems: 'center' },
  content: { width: '100%', maxWidth: 500 },
  metadata: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  mode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  branchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  evaluationCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 12,
    marginTop: 8,
    marginBottom: 12,
    gap: 8,
  },
  evaluationHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  evaluationValue: {
    fontWeight: '700',
    fontSize: 30,
    lineHeight: 36,
    fontVariant: ['tabular-nums'],
  },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mateBadge: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  variationMove: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
  },
  candidateCard: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rank: {
    width: 28,
    minHeight: 28,
    paddingVertical: 3,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  candidateHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: 8,
  },
  emptyCandidates: {
    minHeight: 88,
    padding: 16,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  movesCard: { borderWidth: 1, borderRadius: 14, padding: 8, marginTop: 8 },
  recordMove: {
    flexDirection: 'row',
    minHeight: 44,
    alignItems: 'center',
    gap: 12,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  analysisActions: { marginTop: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  progressTrack: { height: 4, borderRadius: 4, marginVertical: 8, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 4 },
  actionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: 16,
  },
});
