import React, { useMemo } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Line, Polygon } from 'react-native-svg';
import { PieceType, pieceTypeToSFEN } from 'tsshogi';
import { boardView } from '@/domain';
import { Side, SIDE_LABELS } from '@/domain/model';
import { AppText, IconButton } from './primitives';
import { useTheme } from './theme';

const ranks = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const usiRank = 'abcdefghi';
export function ShogiBoard({
  sfen,
  bottomSide = 'black',
  names,
  selected,
  targets = [],
  onSquare,
  onHand,
  arrow,
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
  compact?: boolean;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const board = useMemo(() => boardView(sfen), [sfen]);
  const edge = Math.min(width - 60, 440);
  const cell = (edge - 2) / 9;
  const topSide = bottomSide === 'black' ? 'white' : 'black';
  const files = bottomSide === 'black' ? [9, 8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const rows = bottomSide === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const point = (square: string) => ({
    x: 1 + (files.indexOf(Number(square[0])) + 0.5) * cell,
    y: 1 + (rows.indexOf(usiRank.indexOf(square[1]) + 1) + 0.5) * cell,
  });
  let arrowPoints: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  if (arrow && /^[1-9][a-i][1-9][a-i]/.test(arrow)) {
    const from = point(arrow.slice(0, 2));
    const to = point(arrow.slice(2, 4));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const dx = (to.x - from.x) / distance;
    const dy = (to.y - from.y) / distance;
    arrowPoints = {
      from: { x: from.x + dx * cell * 0.38, y: from.y + dy * cell * 0.38 },
      to: { x: to.x - dx * cell * 0.2, y: to.y - dy * cell * 0.2 },
    };
  }
  const player = (side: Side) => (
    <View style={styles.player}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
        <AppText style={{ color: side === 'black' ? theme.win : theme.accent }}>
          {side === 'black' ? '▲' : '△'}
        </AppText>
        <AppText variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
          {names?.[side] || SIDE_LABELS[side]}
        </AppText>
        {names?.[side] && (
          <AppText variant="caption" tone="secondary">
            {SIDE_LABELS[side]}
          </AppText>
        )}
        {board.turn === side && (
          <View style={[styles.turn, { borderColor: theme.win }]}>
            <AppText variant="small" tone="win">
              手番
            </AppText>
          </View>
        )}
      </View>
      {!board.hands[side].length && (
        <AppText variant="caption" tone="secondary">
          持駒 なし
        </AppText>
      )}
      {board.hands[side].length > 0 && (
        <View style={styles.hands}>
          {board.hands[side].map((hand) => (
            <Pressable
              key={hand.piece}
              disabled={!onHand || side !== board.turn}
              onPress={() => onHand?.(pieceTypeToSFEN(hand.piece as PieceType))}
              accessibilityRole="button"
              accessibilityLabel={`${SIDE_LABELS[side]}の持駒、${hand.label}${hand.count}枚`}
              style={[
                styles.hand,
                {
                  backgroundColor:
                    selected === `${pieceTypeToSFEN(hand.piece as PieceType)}*` &&
                    side === board.turn
                      ? theme.accentSoft
                      : theme.inset,
                },
              ]}
            >
              <AppText variant="headline">
                {hand.label}
                <AppText variant="small">{hand.count > 1 ? hand.count : ''}</AppText>
              </AppText>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
  return (
    <View style={{ alignSelf: 'center', width: edge + 20 }} testID="board">
      {!compact && player(topSide)}
      <View style={{ flexDirection: 'row', paddingRight: 20, marginBottom: 3 }}>
        {files.map((file) => (
          <AppText
            key={file}
            variant="small"
            tone="secondary"
            style={{ width: cell, textAlign: 'center' }}
          >
            {file}
          </AppText>
        ))}
      </View>
      <View style={{ flexDirection: 'row' }}>
        <View
          style={{
            width: edge,
            height: edge,
            backgroundColor: theme.board,
            borderColor: theme.boardLine,
            borderWidth: 1,
          }}
        >
          {rows.map((rank, y) => (
            <View key={rank} style={{ flexDirection: 'row', height: cell }}>
              {files.map((file, x) => {
                const piece = board.cells.find((p) => p.file === file && p.rank === rank);
                const key = `${file}${usiRank[rank - 1]}`;
                return (
                  <Pressable
                    key={key}
                    onPress={() => onSquare?.(key)}
                    disabled={!onSquare}
                    accessibilityRole={onSquare ? 'button' : undefined}
                    accessibilityLabel={`${file}${ranks[rank - 1]}、${piece ? `${SIDE_LABELS[piece.side]}の${piece.label}` : '空きマス'}${targets.includes(key) ? '、移動できます' : ''}`}
                    accessibilityState={{ selected: key === selected }}
                    testID={`square-${key}`}
                    style={{
                      width: cell,
                      height: cell,
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRightWidth: x < 8 ? StyleSheet.hairlineWidth : 0,
                      borderBottomWidth: y < 8 ? StyleSheet.hairlineWidth : 0,
                      borderColor: theme.boardLine,
                      backgroundColor: selected === key ? theme.selection : 'transparent',
                    }}
                  >
                    {targets.includes(key) && (
                      <View
                        pointerEvents="none"
                        style={{
                          position: 'absolute',
                          width: cell * 0.26,
                          height: cell * 0.26,
                          borderRadius: 20,
                          backgroundColor: theme.legal,
                          opacity: 0.65,
                        }}
                      />
                    )}
                    {piece && (
                      <View
                        pointerEvents="none"
                        style={{
                          width: cell * 0.87,
                          height: cell * 0.9,
                          alignItems: 'center',
                          justifyContent: 'center',
                          transform: [{ rotate: piece.side === bottomSide ? '0deg' : '180deg' }],
                        }}
                      >
                        <Svg
                          width="100%"
                          height="100%"
                          viewBox="0 0 40 44"
                          style={StyleSheet.absoluteFill}
                        >
                          <Polygon
                            points="20,2 35,8 38,41 2,41 5,8"
                            fill={theme.piece}
                            stroke={theme.boardLine}
                            strokeWidth="0.8"
                          />
                        </Svg>
                        <AppText
                          allowFontScaling={false}
                          style={{
                            color: theme.pieceText,
                            fontSize: cell * 0.57,
                            fontWeight: '600',
                            lineHeight: cell * 0.74,
                            marginTop: 3,
                          }}
                        >
                          {piece.label}
                        </AppText>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
          {arrowPoints && (
            <Svg pointerEvents="none" width={edge} height={edge} style={StyleSheet.absoluteFill}>
              <Line
                x1={arrowPoints.from.x}
                y1={arrowPoints.from.y}
                x2={arrowPoints.to.x}
                y2={arrowPoints.to.y}
                stroke={theme.legal}
                strokeWidth={4}
                opacity={0.7}
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
        <View style={{ width: 20 }}>
          {rows.map((rank) => (
            <AppText
              key={rank}
              variant="small"
              tone="secondary"
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
}: {
  ply: number;
  total: number;
  playing: boolean;
  onChange: (ply: number) => void;
  onPlay: () => void;
  label?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[styles.playback, { backgroundColor: theme.background, borderTopColor: theme.border }]}
    >
      <AppText
        variant="caption"
        tone="secondary"
        style={{ textAlign: 'center', fontVariant: ['tabular-nums'] }}
        testID="move-counter"
      >
        {label ?? `${ply} / ${total}手`}
      </AppText>
      <View style={styles.controls}>
        <IconButton
          name="first"
          label="初期局面へ"
          testID="move-first"
          onPress={() => onChange(0)}
          disabled={ply === 0}
        />
        <IconButton
          name="previous"
          label="一手戻る"
          testID="move-prev"
          onPress={() => onChange(ply - 1)}
          disabled={ply === 0}
        />
        <View style={{ backgroundColor: theme.accentSoft, borderRadius: 24 }}>
          <IconButton
            name={playing ? 'pause' : 'play'}
            label={playing ? '再生を停止' : '手順を再生'}
            onPress={onPlay}
            disabled={!total}
          />
        </View>
        <IconButton
          name="next"
          label="一手進む"
          onPress={() => onChange(ply + 1)}
          disabled={ply >= total}
          testID="move-next"
        />
        <IconButton
          name="last"
          label="最終局面へ"
          testID="move-last"
          onPress={() => onChange(total)}
          disabled={ply >= total}
        />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  player: {
    minHeight: 48,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  turn: { paddingHorizontal: 6, borderWidth: 1, borderRadius: 12 },
  hands: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  hand: {
    minWidth: 44,
    minHeight: 48,
    paddingHorizontal: 8,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playback: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, paddingHorizontal: 20 },
  controls: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 3 },
});
