import React, { useId, useRef, useState } from 'react';
import { PanResponder, Pressable, useWindowDimensions, View } from 'react-native';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Line,
  LinearGradient,
  Polygon,
  Polyline,
  Rect,
  Stop,
} from 'react-native-svg';
import { AppText } from './primitives';
import { useTheme } from './theme';
import { EVALUATION_CHART_EDGE } from './evaluation';
import { chartIndexAtX, chartPlyTicks } from './chart-geometry';

export function LineChart({
  values,
  selected,
  onSelect,
  valueLabels,
  onScrubStart,
  percent = false,
  height = 110,
}: {
  values: (number | null)[];
  selected?: number;
  onSelect?: (index: number) => void;
  valueLabels?: string[];
  onScrubStart?: () => void;
  percent?: boolean;
  height?: number;
}) {
  const theme = useTheme();
  const clipId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { width: windowWidth } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const previewRef = useRef<number | null>(null);
  const originX = useRef(0);
  const ignoreClickUntil = useRef(0);
  const width = measuredWidth ?? Math.min(windowWidth - 64, 480);
  const chartWidth = Math.max(1, width - 42);
  const left = 5;
  const min = percent ? 0 : -EVALUATION_CHART_EDGE;
  const max = percent ? 100 : EVALUATION_CHART_EDGE;
  const x = (i: number) =>
    left + (values.length <= 1 ? chartWidth / 2 : (i / (values.length - 1)) * chartWidth);
  const y = (n: number) =>
    7 + (1 - (Math.max(min, Math.min(max, n)) - min) / (max - min)) * (height - 17);
  const segments: string[][] = [[]];
  values.forEach((value, i) => {
    if (value === null) {
      if (segments[segments.length - 1].length) segments.push([]);
    } else segments[segments.length - 1].push(`${x(i)},${y(value)}`);
  });
  const hasData = values.some((v) => v !== null);
  const active = preview ?? selected;
  const selectedValue = active === undefined ? null : values[active];
  const selectedColor =
    !percent && selectedValue !== null && selectedValue !== undefined && selectedValue < 0
      ? theme.loss
      : theme.win;
  const last = Math.max(0, values.length - 1);
  const ticks = chartPlyTicks(last, Math.max(2, Math.floor(chartWidth / 65)));
  const activeValid = active !== undefined && active >= 0 && active < values.length;
  const readout = activeValid
    ? (valueLabels?.[active] ??
      (selectedValue == null ? '未解析' : `${selectedValue > 0 ? '+' : ''}${selectedValue}`))
    : '';
  const badgeWidth = active === undefined ? 44 : Math.max(44, String(active).length * 7 + 26);
  const badgeLeft = activeValid
    ? Math.max(0, Math.min(width - badgeWidth, x(active) - badgeWidth / 2))
    : 0;
  // Keep one responder throughout a drag, even when pausing playback rerenders the parent.
  const interaction = useRef({
    onSelect,
    onScrubStart,
    selected,
    count: values.length,
    chartWidth,
  });
  interaction.current = { onSelect, onScrubStart, selected, count: values.length, chartWidth };
  const scrubTo = (pageX: number) => {
    const state = interaction.current;
    const index = chartIndexAtX(pageX - originX.current, left, state.chartWidth, state.count);
    if (index !== null) {
      previewRef.current = index;
      setPreview(index);
    }
  };
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        !!interaction.current.onSelect &&
        interaction.current.count > 0 &&
        gesture.numberActiveTouches === 1 &&
        Math.abs(gesture.dx) > 7 &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3,
      onPanResponderGrant: (event, gesture) => {
        const target = event.currentTarget as unknown as {
          getBoundingClientRect?: () => { left: number };
        };
        if (target.getBoundingClientRect) originX.current = target.getBoundingClientRect().left;
        interaction.current.onScrubStart?.();
        scrubTo(gesture.moveX);
      },
      onPanResponderMove: (_, gesture) => scrubTo(gesture.moveX),
      onPanResponderRelease: (event) => {
        const state = interaction.current;
        // A release may arrive beyond the last coalesced move event.
        const releaseX = event.nativeEvent.changedTouches?.[0]?.pageX ?? event.nativeEvent.pageX;
        const next =
          chartIndexAtX(releaseX - originX.current, left, state.chartWidth, state.count) ??
          previewRef.current;
        previewRef.current = null;
        setPreview(null);
        ignoreClickUntil.current = Date.now() + 250;
        if (next !== null && next !== interaction.current.selected)
          interaction.current.onSelect?.(next);
      },
      onPanResponderTerminationRequest: () => true,
      onPanResponderTerminate: () => {
        previewRef.current = null;
        setPreview(null);
        ignoreClickUntil.current = Date.now() + 250;
      },
    }),
  ).current;
  return (
    <View
      testID={percent ? undefined : 'evaluation-chart'}
      style={{ alignSelf: 'center', width: '100%', maxWidth: 480 }}
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      onTouchStart={(event) => {
        const target = event.currentTarget as unknown as {
          getBoundingClientRect?: () => { left: number };
        };
        originX.current =
          target.getBoundingClientRect?.().left ??
          event.nativeEvent.pageX - event.nativeEvent.locationX;
      }}
      {...pan.panHandlers}
    >
      <Pressable
        testID={percent ? undefined : 'evaluation-chart-plot'}
        disabled={!onSelect || !values.length}
        onPress={(event) => {
          if (Date.now() < ignoreClickUntil.current) return;
          // React Native Web's click is a MouseEvent; native presses provide locationX.
          const target = event.currentTarget as unknown as {
            getBoundingClientRect?: () => { left: number };
          };
          const clientX = (event.nativeEvent as unknown as { clientX?: number }).clientX;
          const locationX = Number.isFinite(event.nativeEvent.locationX)
            ? event.nativeEvent.locationX
            : clientX !== undefined && target.getBoundingClientRect
              ? clientX - target.getBoundingClientRect().left
              : NaN;
          if (!Number.isFinite(locationX) || !values.length) return;
          const next = chartIndexAtX(locationX, left, chartWidth, values.length);
          if (next !== null && next !== selected) onSelect?.(next);
        }}
        accessibilityRole={onSelect ? 'adjustable' : 'image'}
        accessibilityLabel={percent ? '期間内の累計勝率グラフ' : '先手視点の評価値グラフ'}
        accessibilityHint={
          onSelect ? 'タップ、または横になぞって指を離すと、その局面へ移動します' : undefined
        }
        accessibilityValue={
          selected !== undefined && values.length
            ? {
                min: 0,
                max: values.length - 1,
                now: selected,
                text: `${selected}手目、本譜、先手視点、${valueLabels?.[selected] ?? readout}`,
              }
            : undefined
        }
        accessibilityActions={
          onSelect && values.length
            ? [
                { name: 'increment', label: '一手進む' },
                { name: 'decrement', label: '一手戻る' },
              ]
            : undefined
        }
        onAccessibilityAction={(event) => {
          if (!['increment', 'decrement'].includes(event.nativeEvent.actionName)) return;
          onSelect?.(
            Math.max(
              0,
              Math.min(
                values.length - 1,
                (selected ?? 0) + (event.nativeEvent.actionName === 'increment' ? 1 : -1),
              ),
            ),
          );
        }}
      >
        <Svg pointerEvents="none" width={width} height={height}>
          <Defs>
            <LinearGradient id={`${clipId}win`} x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor={theme.win} stopOpacity={0.3} />
              <Stop offset="1" stopColor={theme.win} stopOpacity={0.04} />
            </LinearGradient>
            <LinearGradient id={`${clipId}loss`} x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0" stopColor={theme.loss} stopOpacity={0.04} />
              <Stop offset="1" stopColor={theme.loss} stopOpacity={0.3} />
            </LinearGradient>
            <ClipPath id={`${clipId}positive`}>
              <Rect x={0} y={0} width={width} height={y(0)} />
            </ClipPath>
            <ClipPath id={`${clipId}negative`}>
              <Rect x={0} y={y(0)} width={width} height={height - y(0)} />
            </ClipPath>
          </Defs>
          {!percent && (
            <>
              <Rect
                x={left}
                y={y(max)}
                width={chartWidth}
                height={y(0) - y(max)}
                fill={theme.win}
                opacity={0.035}
              />
              <Rect
                x={left}
                y={y(0)}
                width={chartWidth}
                height={y(min) - y(0)}
                fill={theme.loss}
                opacity={0.025}
              />
              {ticks.map((tick) => (
                <Line
                  key={`x-${tick}`}
                  x1={x(tick)}
                  x2={x(tick)}
                  y1={y(max)}
                  y2={y(min)}
                  stroke={theme.border}
                  opacity={0.5}
                  strokeWidth={0.7}
                  strokeDasharray="2 4"
                />
              ))}
            </>
          )}
          {(percent ? [0, 50, 100] : [-EVALUATION_CHART_EDGE, 0, EVALUATION_CHART_EDGE]).map(
            (n) => (
              <Line
                key={n}
                x1={left}
                x2={left + chartWidth}
                y1={y(n)}
                y2={y(n)}
                stroke={theme.border}
                strokeWidth={n === 0 ? 1 : 0.7}
                strokeDasharray={n === 0 ? undefined : '2 4'}
                opacity={n === 0 ? 1 : 0.6}
              />
            ),
          )}
          {!percent &&
            segments
              .filter((s) => s.length > 1)
              .flatMap((segment, i) =>
                ['positive', 'negative'].map((side) => (
                  <Polygon
                    key={`area-${side}-${i}`}
                    points={`${segment[0].split(',')[0]},${y(0)} ${segment.join(' ')} ${segment[segment.length - 1].split(',')[0]},${y(0)}`}
                    fill={`url(#${clipId}${side === 'positive' ? 'win' : 'loss'})`}
                    clipPath={`url(#${clipId}${side})`}
                  />
                )),
              )}
          {segments
            .filter((s) => s.length > 1)
            .flatMap((segment, i) =>
              (percent ? ['positive'] : ['positive', 'negative']).map((side) => (
                <Polyline
                  key={`${side}-${i}`}
                  points={segment.join(' ')}
                  fill="none"
                  stroke={side === 'positive' ? theme.win : theme.loss}
                  clipPath={percent ? undefined : `url(#${clipId}${side})`}
                  strokeWidth={percent ? 2 : 2.25}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )),
            )}
          {values.map((value, i) =>
            value !== null &&
            (i === 0 ||
              i === values.length - 1 ||
              values[i - 1] === null ||
              values[i + 1] === null) ? (
              <Circle
                key={i}
                cx={x(i)}
                cy={y(value)}
                r={2}
                fill={!percent && value < 0 ? theme.loss : theme.win}
              />
            ) : null,
          )}
          {activeValid && (
            <Line
              x1={x(active)}
              x2={x(active)}
              y1={y(max)}
              y2={height - 3}
              stroke={selectedValue == null ? theme.muted : selectedColor}
              strokeWidth={preview === null ? 1 : 1.5}
              opacity={0.65}
            />
          )}
          {activeValid && selectedValue != null && (
            <Circle
              cx={x(active)}
              cy={y(selectedValue)}
              r={8}
              fill={selectedColor}
              opacity={0.13}
            />
          )}
          {activeValid && selectedValue != null && (
            <Circle
              cx={x(active)}
              cy={y(selectedValue)}
              r="4"
              fill={theme.background}
              stroke={selectedColor}
              strokeWidth="2"
            />
          )}
        </Svg>
        {!hasData && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              inset: 0,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <View
              style={{
                backgroundColor: theme.background,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 4,
              }}
            >
              <AppText variant="caption" tone="secondary">
                {percent ? '勝敗のある対局で表示します' : '解析した局面から表示します'}
              </AppText>
            </View>
          </View>
        )}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', right: 0, top: percent ? 0 : y(0) - 8 }}
        >
          <AppText
            variant="small"
            tone="secondary"
            allowFontScaling={false}
            style={{ fontSize: 10, fontVariant: ['tabular-nums'] }}
          >
            {percent ? '100%' : '0'}
          </AppText>
        </View>
        {!percent &&
          [-EVALUATION_CHART_EDGE, EVALUATION_CHART_EDGE].map((value) => (
            <View
              key={value}
              pointerEvents="none"
              style={{ position: 'absolute', right: 0, top: Math.max(0, y(value) - 8) }}
            >
              <AppText
                variant="small"
                tone="secondary"
                allowFontScaling={false}
                style={{ fontSize: 10, fontVariant: ['tabular-nums'] }}
              >
                {value > 0 ? '+' : '−'}
                {Math.abs(value)}
              </AppText>
            </View>
          ))}
      </Pressable>
      {percent ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingRight: 36,
            paddingLeft: left,
          }}
        >
          <AppText variant="small" tone="secondary">
            {percent ? '期間のはじめ' : '0'}
          </AppText>
          <AppText variant="small" tone="secondary">
            {percent ? '最新の対局' : `${Math.max(0, values.length - 1)}手`}
          </AppText>
        </View>
      ) : (
        <View pointerEvents="none" style={{ height: 22, marginTop: 1 }}>
          {ticks
            .filter((tick) => !activeValid || Math.abs(x(tick) - x(active)) > badgeWidth / 2 + 19)
            .map((tick) => (
              <AppText
                key={tick}
                variant="small"
                tone="secondary"
                allowFontScaling={false}
                style={{
                  position: 'absolute',
                  left: x(tick) - (tick === 0 ? 0 : tick === last ? 32 : 16),
                  width: 32,
                  textAlign: tick === 0 ? 'left' : tick === last ? 'right' : 'center',
                  fontSize: 10,
                  lineHeight: 14,
                  top: 3,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {tick === last ? `${tick}手` : tick}
              </AppText>
            ))}
          {activeValid && (
            <View
              style={{
                position: 'absolute',
                left: badgeLeft,
                top: 0,
                width: badgeWidth,
                height: 20,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 10,
                backgroundColor:
                  selectedValue == null
                    ? theme.inset
                    : selectedValue < 0
                      ? theme.lossSoft
                      : theme.winSoft,
              }}
            >
              <AppText
                testID="chart-selected-ply"
                allowFontScaling={false}
                style={{
                  fontSize: 10,
                  lineHeight: 14,
                  fontWeight: '700',
                  color: selectedValue == null ? theme.secondary : selectedColor,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {active}手
              </AppText>
            </View>
          )}
        </View>
      )}
      {preview !== null && (
        <View
          pointerEvents="none"
          testID="chart-readout"
          style={{
            position: 'absolute',
            left: Math.max(0, Math.min(width - 160, x(preview) - 80)),
            top: -29,
            minWidth: 142,
            maxWidth: 160,
            height: 28,
            paddingHorizontal: 10,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            borderRadius: 6,
            backgroundColor: theme.primary,
          }}
        >
          <AppText
            allowFontScaling={false}
            style={{ color: theme.onPrimary, fontSize: 11, lineHeight: 16 }}
          >
            本譜 {preview}手目
          </AppText>
          <AppText
            allowFontScaling={false}
            style={{
              color: theme.onPrimary,
              fontSize: 12,
              lineHeight: 16,
              fontWeight: '700',
              fontVariant: ['tabular-nums'],
            }}
          >
            {readout}
          </AppText>
        </View>
      )}
    </View>
  );
}
