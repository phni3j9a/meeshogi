import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from 'react-native';
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
  Button,
  EmptyState,
  Group,
  Icon,
  IconButton,
  Notice,
  Segment,
  TextButton,
} from '@/ui/primitives';
import { Playback, ShogiBoard } from '@/ui/board';
import { LineChart } from '@/ui/charts';
import { gameTitle, openingDescription } from '@/ui/game-row';
import { openMateSession } from '@/ui/mate-session';
import { useTheme } from '@/ui/theme';
import { errorMessage, useChoice } from '@/ui/use-choice';
import { currentGameAnalysis, isCompatibleAnalysis } from '@/analysis/cache';

type Branch = { origin: number; positions: string[]; moves: string[]; cursor: number };
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
  const proven =
    settings.showMateBadges &&
    proof?.status === 'proven' &&
    (proof.plies === 1 || proof.plies === 3) &&
    proof.side === position?.turn;
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
  return (
    <View
      style={{ flex: 1, backgroundColor: theme.background, paddingBottom: insets.bottom }}
      testID="game-screen"
    >
      <Stack.Screen
        options={{
          title: branch ? '分岐検討' : '検討',
          headerLeft: branch
            ? () => <IconButton label="本譜に戻る" name="previous" onPress={leaveBranch} />
            : undefined,
          headerRight: () => (
            <IconButton name="more" label="棋譜の操作" onPress={() => void menu()} />
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {branch ? (
          <View
            style={{
              backgroundColor: theme.accentSoft,
              borderRadius: 12,
              paddingHorizontal: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <Icon name="branch" size={19} />
            <AppText variant="caption" style={{ flex: 1 }}>
              {branch.origin}手目から分岐
            </AppText>
            <TextButton label="本譜に戻る" onPress={leaveBranch} />
          </View>
        ) : (
          <View style={{ paddingVertical: 8 }}>
            <AppText variant="headline" numberOfLines={2}>
              {gameTitle(game)}
            </AppText>
            <AppText variant="caption" tone="secondary">
              {openingDescription(game)}
            </AppText>
          </View>
        )}
        <ShogiBoard
          sfen={sfen}
          bottomSide={bottomSide}
          names={{ black: game.blackName, white: game.whiteName }}
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
        {error && <Notice text={error} error action="閉じる" onAction={() => setError('')} />}
        <View
          testID={
            candidates.length > 0 && currentAnalysis?.sfen === sfen ? 'analysis-ready' : undefined
          }
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            marginTop: 6,
            flexWrap: 'wrap',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <AppText
              selectable
              style={{
                fontWeight: '700',
                fontSize: 26,
                lineHeight: 34,
                fontVariant: ['tabular-nums'],
              }}
            >
              {candidates[0]?.scoreCp !== null && candidates[0]?.scoreCp !== undefined
                ? `${candidates[0].scoreCp > 0 ? '+' : ''}${candidates[0].scoreCp}`
                : '—'}
            </AppText>
            <AppText variant="caption" tone="secondary">
              先手評価
            </AppText>
          </View>
          {proven && proof && (
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
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderColor: theme.accent,
                borderWidth: 1,
                borderRadius: 12,
              }}
            >
              <AppText variant="caption" tone="accent">
                {SIDE_LABELS[proof.side]}・{proof.plies}手詰め ›
              </AppText>
            </Pressable>
          )}
        </View>
        {!branch && (
          <LineChart
            values={mainlineAnalysis.map((result) => result?.candidates[0]?.scoreCp ?? null)}
            selected={ply}
            onSelect={(next) => go(next)}
            height={82}
          />
        )}
        {branch && (
          <>
            <AppText variant="headline" style={{ marginTop: 18, marginBottom: 8 }}>
              分岐の手順
            </AppText>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6 }}
            >
              {branch.moves.map((move, index) => (
                <Pressable
                  key={`${index}-${move}`}
                  accessibilityRole="button"
                  onPress={() => go(index + 1)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: index + 1 === branch.cursor ? theme.accent : theme.border,
                    backgroundColor: index + 1 === branch.cursor ? theme.accentSoft : theme.surface,
                  }}
                >
                  <AppText variant="caption">
                    {branch.origin + index + 1}　{moveLabel(branch.positions[index], move)}
                  </AppText>
                </Pressable>
              ))}
            </ScrollView>
            <AppText variant="small" tone="secondary" style={{ marginTop: 6 }}>
              この分岐は保存されません。本譜と戦績は変わりません。
            </AppText>
          </>
        )}
        {!branch && <Segment labels={['候補手', '棋譜']} selected={tab} onChange={setTab} />}
        {tab === 0 || branch ? (
          <View>
            {candidates.map((candidate, index) => (
              <Pressable
                key={candidate.usi}
                testID={`candidate-${index}`}
                accessibilityRole="button"
                onPress={() =>
                  previewCandidate(candidate.pv.length ? candidate.pv : [candidate.usi])
                }
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 48,
                  gap: 12,
                  paddingVertical: 10,
                  borderBottomColor: theme.border,
                  borderBottomWidth: 0.5,
                  backgroundColor: pressed ? theme.inset : 'transparent',
                })}
              >
                <View
                  style={{
                    width: 25,
                    height: 25,
                    borderRadius: 14,
                    backgroundColor: index === 0 ? theme.win : theme.secondary,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <AppText variant="caption" style={{ color: theme.background }}>
                    {index + 1}
                  </AppText>
                </View>
                <AppText style={{ flex: 1 }}>{moveLabel(sfen, candidate.usi)}</AppText>
                <AppText style={{ fontVariant: ['tabular-nums'] }}>
                  {candidate.scoreCp !== null
                    ? `${candidate.scoreCp > 0 ? '+' : ''}${candidate.scoreCp}`
                    : '—'}
                </AppText>
                <Icon name="next" size={16} color={theme.muted} />
              </Pressable>
            ))}
            {!candidates.length && (
              <View style={{ minHeight: 60, justifyContent: 'center' }}>
                <AppText variant="caption" tone="secondary">
                  {focusBusy
                    ? 'この局面を解析しています…'
                    : !validMoves.length
                      ? 'この局面には合法手がありません。'
                      : '解析すると候補手を確認できます。'}
                </AppText>
              </View>
            )}
          </View>
        ) : (
          <View style={{ gap: 2, paddingVertical: 8 }}>
            <AppText variant="caption" tone="secondary">
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
                    style={{
                      flexDirection: 'row',
                      minHeight: 44,
                      alignItems: 'center',
                      gap: 16,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      backgroundColor: movePly === ply ? theme.accentSoft : 'transparent',
                    }}
                  >
                    <AppText variant="caption" tone="secondary">
                      {movePly}
                    </AppText>
                    <AppText style={{ flex: 1 }}>{move.label}</AppText>
                    <AppText variant="caption" tone="secondary">
                      {Math.floor(move.elapsedMs / 1000)}秒
                    </AppText>
                  </Pressable>
                );
              })}
          </View>
        )}
        <View style={{ marginTop: 10 }}>
          {!branch && previousResults > 0 && (
            <Notice
              text={`以前のモデル・解析条件の結果が${previousResults}局面あります。現在の設定で解析し直せます。`}
            />
          )}
          <AppText variant="caption" tone="secondary" testID="analysis-status">
            {branch
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
                        : 'この棋譜は未解析です'}
          </AppText>
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
              accessibilityValue={{ now: completed, min: 0, max: job.total }}
              style={{
                backgroundColor: theme.inset,
                height: 4,
                borderRadius: 4,
                marginVertical: 8,
              }}
            >
              <View
                style={{
                  backgroundColor: theme.win,
                  height: 4,
                  borderRadius: 4,
                  width: `${(completed / job.total) * 100}%`,
                }}
              />
            </View>
          )}
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              columnGap: 16,
            }}
          >
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
                  icon="play"
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
      />
    </View>
  );
}
