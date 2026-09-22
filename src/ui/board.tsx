import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Path, Polygon } from 'react-native-svg';
import { PieceType, pieceTypeToSFEN } from 'tsshogi';
import { boardView } from '@/domain';
import { Side, SIDE_LABELS } from '@/domain/model';
import { PieceImage } from './piece-image';
import { AppText, IconButton } from './primitives';
import { useTheme } from './theme';

const ranks = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const usiRank = 'abcdefghi';
const rankGutter = 18;

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
  compact?: boolean;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState<number>();
  const board = useMemo(() => boardView(sfen), [sfen]);
  const cells = useMemo(
    () => new Map(board.cells.map((piece) => [`${piece.file}${usiRank[piece.rank - 1]}`, piece])),
    [board],
  );
  // Measure the actual parent: a tablet sheet may be much narrower than its window.
  const edge = Math.max(0, Math.min(containerWidth ?? width - 24, 440 + rankGutter) - rankGutter);
  const cell = Math.max(0, edge - 2) / 9;
  const topSide = bottomSide === 'black' ? 'white' : 'black';
  const files = bottomSide === 'black' ? [9, 8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const rows = bottomSide === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const ordinaryMove = lastMove?.match(/^([1-9][a-i])([1-9][a-i])\+?$/);
  const dropMove = lastMove?.match(/^[PLNSGBR]\*([1-9][a-i])$/);
  const lastFrom = ordinaryMove?.[1];
  const lastTo = ordinaryMove?.[2] ?? dropMove?.[1];
  const point = (square: string) => ({
    x: 1 + (files.indexOf(Number(square[0])) + 0.5) * cell,
    y: 1 + (rows.indexOf(usiRank.indexOf(square[1]) + 1) + 0.5) * cell,
  });
  let arrowPoints: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  if (arrow && /^[1-9][a-i][1-9][a-i]\+?$/.test(arrow)) {
    const from = point(arrow.slice(0, 2));
    const to = point(arrow.slice(2, 4));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance > 0) {
      const dx = (to.x - from.x) / distance;
      const dy = (to.y - from.y) / distance;
      arrowPoints = {
        from: { x: from.x + dx * cell * 0.34, y: from.y + dy * cell * 0.34 },
        to: { x: to.x - dx * cell * 0.16, y: to.y - dy * cell * 0.16 },
      };
    }
  }
  const player = (side: Side) => (
    <View style={styles.player}>
      <View style={styles.playerHeading}>
        <View
          accessible
          accessibilityLabel={`${SIDE_LABELS[side]}${board.turn === side ? '、手番' : ''}`}
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
          {board.turn === side && (
            <View
              style={[
                styles.turnDot,
                { backgroundColor: theme.win, borderColor: theme.background },
              ]}
            />
          )}
        </View>
        <AppText numberOfLines={1} style={styles.playerName}>
          {names?.[side] || SIDE_LABELS[side]}
        </AppText>
      </View>
      {board.hands[side].length > 0 ? (
        <View
          style={[
            styles.handTray,
            {
              backgroundColor: theme.inset,
              width: Math.min(board.hands[side].length * 46 - 2, (edge + rankGutter) * 0.53),
            },
          ]}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.hands}
            contentContainerStyle={styles.handContents}
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
        </View>
      ) : (
        <AppText variant="small" tone="secondary">
          持駒 なし
        </AppText>
      )}
    </View>
  );
  return (
    <View
      style={styles.boardContainer}
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
        <View
          style={[
            styles.boardSurface,
            {
              width: edge,
              height: edge,
              backgroundColor: theme.board,
              borderColor: theme.boardLine,
            },
          ]}
        >
          <Svg
            pointerEvents="none"
            width={edge - 2}
            height={edge - 2}
            viewBox="0 0 440 440"
            style={StyleSheet.absoluteFill}
          >
            {Array.from({ length: 18 }, (_, index) => (
              <Path
                key={index}
                d={`M ${8 + index * 26} 0 C ${index * 26 - 7} 130, ${index * 26 + 21} 300, ${index * 26 + 11} 440`}
                fill="none"
                stroke={theme.boardLine}
                strokeWidth={index % 3 === 0 ? 1.4 : 0.6}
                opacity={0.07}
              />
            ))}
          </Svg>
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
                      borderColor: theme.boardLine,
                      backgroundColor: isSelected
                        ? theme.selection
                        : key === lastTo
                          ? '#D8AD4B73'
                          : key === lastFrom
                            ? '#B58B3030'
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
            width={edge - 2}
            height={edge - 2}
            style={StyleSheet.absoluteFill}
          >
            {[3, 6].flatMap((x) =>
              [3, 6].map((y) => (
                <Circle
                  key={`${x}-${y}`}
                  cx={x * cell}
                  cy={y * cell}
                  r={1.7}
                  fill={theme.boardLine}
                />
              )),
            )}
          </Svg>
          {arrowPoints && (
            <Svg pointerEvents="none" width={edge} height={edge} style={StyleSheet.absoluteFill}>
              <Line
                x1={arrowPoints.from.x}
                y1={arrowPoints.from.y}
                x2={arrowPoints.to.x}
                y2={arrowPoints.to.y}
                stroke={theme.legal}
                strokeWidth={4}
                strokeLinecap="round"
                opacity={0.8}
              />
              <Polygon
                points={`${arrowPoints.to.x},${arrowPoints.to.y - 7} ${arrowPoints.to.x - 5},${arrowPoints.to.y + 4} ${arrowPoints.to.x + 5},${arrowPoints.to.y + 4}`}
                fill={theme.legal}
                rotation={
                  (Math.atan2(
                    arrowPoints.to.y - arrowPoints.from.y,
                    arrowPoints.to.x - arrowPoints.from.x,
                  ) *
                    180) /
                    Math.PI +
                  90
                }
                origin={`${arrowPoints.to.x},${arrowPoints.to.y}`}
              />
            </Svg>
          )}
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
        <IconButton
          name="first"
          label="初期局面へ"
          testID="move-first"
          onPress={() => onChange(0)}
          disabled={ply === 0}
          size={20}
        />
        <View style={[styles.stepButton, { backgroundColor: theme.inset }]}>
          <IconButton
            name="previous"
            label="一手戻る"
            testID="move-prev"
            onPress={() => onChange(ply - 1)}
            disabled={ply === 0}
            size={21}
          />
        </View>
        <IconButton
          name={playing ? 'pause' : 'play'}
          label={playing ? '再生を停止' : '手順を再生'}
          testID="move-play"
          onPress={onPlay}
          disabled={!total}
          filled
          size={21}
        />
        <View style={[styles.stepButton, { backgroundColor: theme.inset }]}>
          <IconButton
            name="next"
            label="一手進む"
            testID="move-next"
            onPress={() => onChange(ply + 1)}
            disabled={ply >= total}
            size={21}
          />
        </View>
        <IconButton
          name="last"
          label="最終局面へ"
          testID="move-last"
          onPress={() => onChange(total)}
          disabled={ply >= total}
          size={20}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  boardContainer: { alignSelf: 'center', width: '100%', maxWidth: 440 + rankGutter },
  boardRow: { flexDirection: 'row' },
  boardSurface: { borderWidth: 1, borderRadius: 2, overflow: 'hidden' },
  fileLabels: { flexDirection: 'row', paddingLeft: 1, paddingBottom: 3 },
  rankLabels: { width: rankGutter, paddingTop: 1 },
  player: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, minHeight: 50, gap: 8 },
  playerHeading: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0, gap: 7 },
  sideMark: {
    width: 21,
    height: 21,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerName: { fontSize: 14, lineHeight: 21, fontWeight: '600', flex: 1, minWidth: 0 },
  turnDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 8,
    height: 8,
    borderWidth: 1.5,
    borderRadius: 4,
  },
  handTray: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    overflow: 'hidden',
  },
  hands: { flex: 1 },
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
    paddingTop: 8,
    paddingBottom: 5,
    paddingHorizontal: 20,
  },
  playbackHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 20,
  },
  moveCounter: { fontVariant: ['tabular-nums'], flexShrink: 1 },
  currentMove: { fontWeight: '600', flexShrink: 1 },
  controls: {
    width: '100%',
    maxWidth: 370,
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 5,
  },
  stepButton: { borderRadius: 15 },
});
