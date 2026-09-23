import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Line, Path, Rect, Stop } from 'react-native-svg';
import { PieceType, pieceTypeToSFEN } from 'tsshogi';
import { boardView } from '@/domain';
import { Side, SIDE_LABELS } from '@/domain/model';
import { PieceImage } from './piece-image';
import { AppText, Icon, IconName } from './primitives';
import { useTheme } from './theme';

const ranks = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const usiRank = 'abcdefghi';
const coordinateGutter = 14;
const woodFrame = 4;

export function ShogiBoard({
  sfen,
  bottomSide = 'black',
  names,
  selected,
  targets = [],
  onSquare,
  onHand,
  arrow,
  lastMove,
  maxEdge = 440,
  compact = false,
}: {
  sfen: string;
  bottomSide?: Side;
  names?: Record<Side, string>;
  selected?: string | null;
  targets?: string[];
  onSquare?: (square: string) => void;
  onHand?: (piece: string) => void;
  arrow?: string;
  lastMove?: string;
  maxEdge?: number;
  compact?: boolean;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState<number>();
  const board = useMemo(() => boardView(sfen), [sfen]);
  const handOffsets = useRef<Record<Side, number>>({ black: 0, white: 0 });
  const [handHasMore, setHandHasMore] = useState<Record<Side, boolean>>({
    black: true,
    white: true,
  });
  useEffect(() => {
    for (const side of ['black', 'white'] as const) {
      if (!board.hands[side].length) handOffsets.current[side] = 0;
    }
  }, [board]);
  const updateHandHint = (side: Side, contentWidth: number, viewportWidth: number) => {
    const more = contentWidth - viewportWidth - handOffsets.current[side] > 1;
    setHandHasMore((previous) =>
      previous[side] === more ? previous : { ...previous, [side]: more },
    );
  };
  const cells = useMemo(
    () => new Map(board.cells.map((piece) => [`${piece.file}${usiRank[piece.rank - 1]}`, piece])),
    [board],
  );
  // Measure the actual parent: a tablet sheet may be much narrower than its window.
  const edge = Math.max(
    0,
    Math.min((containerWidth ?? width - 24) - coordinateGutter * 2, maxEdge),
  );
  const gridEdge = Math.max(0, edge - woodFrame * 2);
  const cell = gridEdge / 9;
  const gridColor = theme.dark ? '#7D6A4D' : '#B09A77';
  const frameColor = theme.dark ? '#79633F' : '#B69768';
  const topSide = bottomSide === 'black' ? 'white' : 'black';
  const files = bottomSide === 'black' ? [9, 8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const rows = bottomSide === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const ordinaryMove = lastMove?.match(/^([1-9][a-i])([1-9][a-i])\+?$/);
  const dropMove = lastMove?.match(/^[PLNSGBR]\*([1-9][a-i])$/);
  const lastFrom = ordinaryMove?.[1];
  const lastTo = ordinaryMove?.[2] ?? dropMove?.[1];
  const candidateMove = arrow?.match(/^([1-9][a-i])([1-9][a-i])\+?$/);
  const candidateDrop = arrow?.match(/^[PLNSGBR]\*([1-9][a-i])$/);
  const candidateDestination = candidateMove?.[2] ?? candidateDrop?.[1];
  const point = (square: string) => ({
    x: (files.indexOf(Number(square[0])) + 0.5) * cell,
    y: (rows.indexOf(usiRank.indexOf(square[1]) + 1) + 0.5) * cell,
  });
  let arrowPoints: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    head: string;
  } | null = null;
  if (candidateMove) {
    const from = point(candidateMove[1]);
    const to = point(candidateMove[2]);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance > 0) {
      const dx = (to.x - from.x) / distance;
      const dy = (to.y - from.y) / distance;
      const tip = { x: to.x - dx * cell * 0.43, y: to.y - dy * cell * 0.43 };
      arrowPoints = {
        from: { x: from.x + dx * cell * 0.43, y: from.y + dy * cell * 0.43 },
        to: tip,
        head: `M ${tip.x - dx * 4 - dy * 3} ${tip.y - dy * 4 + dx * 3} L ${tip.x} ${tip.y} L ${tip.x - dx * 4 + dy * 3} ${tip.y - dy * 4 - dx * 3}`,
      };
    }
  }
  const player = (side: Side) => {
    const handWidth = Math.min(
      board.hands[side].length * 46 - 2,
      (edge + coordinateGutter * 2) * 0.53,
    );
    const handOverflow = board.hands[side].length * 46 - 2 > handWidth;
    return (
      <View style={styles.player}>
        <View style={styles.playerHeading}>
          <View
            accessible
            accessibilityLabel={SIDE_LABELS[side]}
            style={[
              styles.sideMark,
              {
                backgroundColor: side === 'black' ? theme.primary : theme.surface,
                borderColor: theme.border,
              },
            ]}
          >
            <AppText
              allowFontScaling={false}
              style={{
                fontSize: 11,
                lineHeight: 16,
                color: side === 'black' ? theme.onPrimary : theme.text,
              }}
            >
              {side === 'black' ? '▲' : '△'}
            </AppText>
          </View>
          <AppText numberOfLines={1} style={styles.playerName}>
            {names?.[side] || SIDE_LABELS[side]}
          </AppText>
          {board.turn === side && (
            <AppText variant="small" tone="win" style={styles.turnLabel}>
              手番
            </AppText>
          )}
        </View>
        {board.hands[side].length > 0 ? (
          <View
            style={[
              styles.handTray,
              {
                backgroundColor: theme.inset,
                width: handWidth,
              },
            ]}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityLabel={`${SIDE_LABELS[side]}の持駒`}
              accessibilityHint={
                handOverflow ? '左右にスクロールしてすべての持駒を確認できます' : undefined
              }
              style={styles.hands}
              contentContainerStyle={[styles.handContents, handOverflow && { paddingRight: 14 }]}
              scrollEventThrottle={16}
              onScroll={({ nativeEvent }) => {
                handOffsets.current[side] = Math.max(0, nativeEvent.contentOffset.x);
                updateHandHint(
                  side,
                  nativeEvent.contentSize.width,
                  nativeEvent.layoutMeasurement.width,
                );
              }}
              onContentSizeChange={(contentWidth) => updateHandHint(side, contentWidth, handWidth)}
            >
              {board.hands[side].map((hand) => {
                const code = pieceTypeToSFEN(hand.piece as PieceType);
                const isSelected = selected === `${code}*` && side === board.turn;
                const disabled = !onHand || side !== board.turn;
                return (
                  <Pressable
                    key={hand.piece}
                    disabled={disabled}
                    onPress={() => onHand?.(code)}
                    accessibilityRole="button"
                    accessibilityLabel={`${SIDE_LABELS[side]}の持駒、${hand.label}${hand.count}枚`}
                    accessibilityState={{ selected: isSelected, disabled }}
                    style={({ pressed }) => [
                      styles.hand,
                      {
                        backgroundColor: isSelected ? theme.accentSoft : 'transparent',
                        borderColor: isSelected ? theme.accent : 'transparent',
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <PieceImage
                      piece={hand.piece as PieceType}
                      side={side}
                      width={31}
                      height={37}
                      rotated={side !== bottomSide}
                    />
                    {hand.count > 1 && (
                      <View style={[styles.handCount, { backgroundColor: theme.surface }]}>
                        <AppText allowFontScaling={false} style={styles.handCountText}>
                          {hand.count}
                        </AppText>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
            {handOverflow && handHasMore[side] && (
              <Svg pointerEvents="none" width={14} height={44} style={styles.handFade}>
                <Defs>
                  <LinearGradient id={`hand-fade-${side}`} x1="0" x2="1" y1="0" y2="0">
                    <Stop offset="0" stopColor={theme.inset} stopOpacity={0} />
                    <Stop offset="1" stopColor={theme.inset} stopOpacity={1} />
                  </LinearGradient>
                </Defs>
                <Rect width={14} height={44} fill={`url(#hand-fade-${side})`} />
                <Path
                  d="M 8 19 L 11 22 L 8 25"
                  stroke={theme.secondary}
                  strokeWidth={1.2}
                  fill="none"
                />
              </Svg>
            )}
          </View>
        ) : (
          <AppText variant="small" tone="secondary">
            持駒 なし
          </AppText>
        )}
      </View>
    );
  };
  return (
    <View
      style={[styles.boardContainer, { maxWidth: maxEdge + coordinateGutter * 2 }]}
      testID="board"
      onLayout={({ nativeEvent }) => {
        const measuredWidth = nativeEvent.layout.width;
        setContainerWidth((previous) =>
          previous !== undefined && Math.abs(previous - measuredWidth) < 0.5
            ? previous
            : measuredWidth,
        );
      }}
    >
      {!compact && player(topSide)}
      <View style={[styles.fileLabels, { width: edge }]}>
        {files.map((file) => (
          <AppText
            key={file}
            variant="small"
            tone="secondary"
            allowFontScaling={false}
            style={{ width: cell, textAlign: 'center' }}
          >
            {file}
          </AppText>
        ))}
      </View>
      <View style={styles.boardRow}>
        <View style={{ width: coordinateGutter }} />
        <View
          style={[
            styles.boardSurface,
            {
              width: edge,
              height: edge,
              backgroundColor: theme.board,
              borderColor: frameColor,
            },
          ]}
        >
          <View style={{ width: gridEdge, height: gridEdge }}>
            <Svg
              pointerEvents="none"
              width={gridEdge}
              height={gridEdge}
              viewBox="0 0 440 440"
              style={StyleSheet.absoluteFill}
            >
              {Array.from({ length: 18 }, (_, index) => (
                <Path
                  key={index}
                  d={`M ${8 + index * 26} 0 C ${index * 26 - 7} 130, ${index * 26 + 21} 300, ${index * 26 + 11} 440`}
                  fill="none"
                  stroke={gridColor}
                  strokeWidth={index % 3 === 0 ? 1.4 : 0.6}
                  opacity={0.06}
                />
              ))}
            </Svg>
            {arrowPoints && (
              <Svg
                pointerEvents="none"
                width={gridEdge}
                height={gridEdge}
                style={StyleSheet.absoluteFill}
              >
                <Line
                  x1={arrowPoints.from.x}
                  y1={arrowPoints.from.y}
                  x2={arrowPoints.to.x}
                  y2={arrowPoints.to.y}
                  stroke={theme.legal}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  opacity={0.75}
                />
                <Path
                  d={arrowPoints.head}
                  stroke={theme.legal}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </Svg>
            )}
            {rows.map((rank, y) => (
              <View key={rank} style={{ flexDirection: 'row', height: cell }}>
                {files.map((file, x) => {
                  const key = `${file}${usiRank[rank - 1]}`;
                  const piece = cells.get(key);
                  const isSelected = selected === key;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => onSquare?.(key)}
                      disabled={!onSquare}
                      accessibilityRole={onSquare ? 'button' : undefined}
                      accessibilityLabel={`${file}${ranks[rank - 1]}、${piece ? `${SIDE_LABELS[piece.side]}の${piece.label}` : '空きマス'}${targets.includes(key) ? '、移動できます' : ''}`}
                      accessibilityState={{ selected: isSelected }}
                      testID={`square-${key}`}
                      style={{
                        width: cell,
                        height: cell,
                        justifyContent: 'center',
                        alignItems: 'center',
                        borderRightWidth: x < 8 ? StyleSheet.hairlineWidth : 0,
                        borderBottomWidth: y < 8 ? StyleSheet.hairlineWidth : 0,
                        borderColor: gridColor,
                        backgroundColor: isSelected
                          ? theme.selection
                          : key === lastTo
                            ? '#D8AD4B48'
                            : key === lastFrom
                              ? '#B58B3020'
                              : 'transparent',
                      }}
                    >
                      {(isSelected || key === lastTo) && (
                        <View
                          pointerEvents="none"
                          style={[
                            StyleSheet.absoluteFill,
                            { borderWidth: isSelected ? 2 : 1, borderColor: theme.accent },
                          ]}
                        />
                      )}
                      {piece && (
                        <PieceImage
                          piece={piece.piece as PieceType}
                          side={piece.side}
                          width={cell * 0.92}
                          height={cell * 0.94}
                          rotated={piece.side !== bottomSide}
                        />
                      )}
                      {key === candidateDestination && (
                        <View
                          pointerEvents="none"
                          style={[
                            StyleSheet.absoluteFill,
                            {
                              margin: 1.5,
                              borderRadius: 2,
                              borderWidth: 1.5,
                              borderColor: theme.legal,
                              opacity: 0.8,
                            },
                          ]}
                        />
                      )}
                      {candidateDrop && key === candidateDestination && !piece && (
                        <View
                          pointerEvents="none"
                          style={{
                            position: 'absolute',
                            width: cell * 0.32,
                            height: cell * 0.32,
                            borderRadius: cell,
                            borderWidth: 1.8,
                            borderColor: theme.legal,
                          }}
                        />
                      )}
                      {targets.includes(key) && (
                        <View
                          pointerEvents="none"
                          style={{
                            position: 'absolute',
                            width: piece ? cell * 0.78 : cell * 0.22,
                            height: piece ? cell * 0.78 : cell * 0.22,
                            borderRadius: cell,
                            borderWidth: piece ? 2 : 0,
                            borderColor: theme.legal,
                            backgroundColor: piece ? 'transparent' : theme.legal,
                            opacity: 0.82,
                          }}
                        />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            ))}
            <Svg
              pointerEvents="none"
              width={gridEdge}
              height={gridEdge}
              style={StyleSheet.absoluteFill}
            >
              {[3, 6].flatMap((x) =>
                [3, 6].map((y) => (
                  <Circle key={`${x}-${y}`} cx={x * cell} cy={y * cell} r={1.5} fill={gridColor} />
                )),
              )}
            </Svg>
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { borderWidth: StyleSheet.hairlineWidth, borderColor: gridColor },
              ]}
            />
          </View>
        </View>
        <View style={styles.rankLabels}>
          {rows.map((rank) => (
            <AppText
              key={rank}
              variant="small"
              tone="secondary"
              allowFontScaling={false}
              style={{ height: cell, textAlign: 'right', lineHeight: cell }}
            >
              {ranks[rank - 1]}
            </AppText>
          ))}
        </View>
      </View>
      {!compact && player(bottomSide)}
    </View>
  );
}

export function Playback({
  ply,
  total,
  playing,
  onChange,
  onPlay,
  label,
  moveLabel,
}: {
  ply: number;
  total: number;
  playing: boolean;
  onChange: (ply: number) => void;
  onPlay: () => void;
  label?: string;
  moveLabel?: string;
}) {
  const theme = useTheme();
  const control = (
    name: IconName,
    text: string,
    testID: string,
    action: () => void,
    disabled: boolean,
    primary = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={action}
      disabled={disabled}
      style={({ pressed }) => [styles.control, { opacity: disabled ? 0.28 : pressed ? 0.55 : 1 }]}
    >
      <View style={[styles.controlFace, primary && { backgroundColor: theme.primary }]}>
        <Icon name={name} size={20} color={primary ? theme.onPrimary : theme.text} />
      </View>
    </Pressable>
  );
  return (
    <View
      style={[styles.playback, { backgroundColor: theme.surface, borderTopColor: theme.border }]}
    >
      <View style={styles.playbackHeading}>
        <AppText
          variant="caption"
          tone="secondary"
          style={styles.moveCounter}
          testID="move-counter"
        >
          {label ?? `${ply} / ${total}手`}
        </AppText>
        {moveLabel && (
          <AppText variant="caption" numberOfLines={1} style={styles.currentMove}>
            {moveLabel}
          </AppText>
        )}
      </View>
      <View style={styles.controls}>
        {control('first', '初期局面へ', 'move-first', () => onChange(0), ply === 0)}
        {control('previous', '一手戻る', 'move-prev', () => onChange(ply - 1), ply === 0)}
        {control(
          playing ? 'pause' : 'play',
          playing ? '再生を停止' : '手順を再生',
          'move-play',
          onPlay,
          !total,
          true,
        )}
        {control('next', '一手進む', 'move-next', () => onChange(ply + 1), ply >= total)}
        {control('last', '最終局面へ', 'move-last', () => onChange(total), ply >= total)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  boardContainer: { alignSelf: 'center', width: '100%' },
  boardRow: { flexDirection: 'row', justifyContent: 'center' },
  boardSurface: { borderWidth: 1, padding: woodFrame - 1, borderRadius: 3, overflow: 'hidden' },
  fileLabels: {
    alignSelf: 'center',
    flexDirection: 'row',
    paddingLeft: woodFrame,
    paddingBottom: 2,
  },
  rankLabels: { width: coordinateGutter, paddingTop: woodFrame },
  player: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8 },
  playerHeading: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0, gap: 6 },
  sideMark: {
    width: 21,
    height: 21,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerName: { fontSize: 14, lineHeight: 20, fontWeight: '600', flex: 1, minWidth: 0 },
  turnLabel: { fontSize: 11, lineHeight: 16 },
  handTray: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    overflow: 'hidden',
  },
  hands: { flex: 1 },
  handFade: { position: 'absolute', right: 0, top: 0 },
  handContents: { gap: 2 },
  hand: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  handCount: {
    position: 'absolute',
    right: 1,
    bottom: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  handCountText: { fontSize: 10, lineHeight: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  playback: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    paddingBottom: 3,
    paddingHorizontal: 20,
  },
  playbackHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 18,
  },
  moveCounter: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'], flexShrink: 1 },
  currentMove: { fontSize: 13, lineHeight: 18, fontWeight: '600', flexShrink: 1 },
  controls: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 2,
  },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  controlFace: {
    width: 40,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
