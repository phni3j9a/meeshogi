import React, { useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline } from 'react-native-svg';
import { AppText } from './primitives';
import { useTheme } from './theme';
import { EVALUATION_CHART_EDGE } from './evaluation';

export function LineChart({
  values,
  selected,
  onSelect,
  percent = false,
  height = 110,
}: {
  values: (number | null)[];
  selected?: number;
  onSelect?: (index: number) => void;
  percent?: boolean;
  height?: number;
}) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const width = measuredWidth ?? Math.min(windowWidth - 64, 480);
  const chartWidth = Math.max(1, width - 40);
  const left = 4;
  const min = percent ? 0 : -EVALUATION_CHART_EDGE;
  const max = percent ? 100 : EVALUATION_CHART_EDGE;
  const x = (i: number) =>
    left + (values.length <= 1 ? chartWidth / 2 : (i / (values.length - 1)) * chartWidth);
  const y = (n: number) =>
    5 + (1 - (Math.max(min, Math.min(max, n)) - min) / (max - min)) * (height - 20);
  const segments: string[][] = [[]];
  values.forEach((value, i) => {
    if (value === null) {
      if (segments[segments.length - 1].length) segments.push([]);
    } else segments[segments.length - 1].push(`${x(i)},${y(value)}`);
  });
  const hasData = values.some((v) => v !== null);
  return (
    <View
      style={{ alignSelf: 'center', width: '100%', maxWidth: 480 }}
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
    >
      <Pressable
        disabled={!onSelect || !values.length}
        onPress={(event) => {
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
          onSelect?.(
            Math.max(
              0,
              Math.min(
                values.length - 1,
                Math.round(((locationX - left) / chartWidth) * (values.length - 1)),
              ),
            ),
          );
        }}
        accessibilityRole={onSelect ? 'adjustable' : 'image'}
        accessibilityLabel={percent ? '期間内の累計勝率グラフ' : '先手視点の評価値グラフ'}
        accessibilityValue={
          selected !== undefined && values.length
            ? { min: 0, max: values.length - 1, now: selected }
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
        onAccessibilityAction={(event) =>
          onSelect?.(
            Math.max(
              0,
              Math.min(
                values.length - 1,
                (selected ?? 0) + (event.nativeEvent.actionName === 'increment' ? 1 : -1),
              ),
            ),
          )
        }
      >
        <Svg pointerEvents="none" width={width} height={height}>
          {(percent ? [0, 50, 100] : [-EVALUATION_CHART_EDGE, 0, EVALUATION_CHART_EDGE]).map(
            (n) => (
              <Line
                key={n}
                x1={left}
                x2={left + chartWidth}
                y1={y(n)}
                y2={y(n)}
                stroke={theme.border}
                strokeDasharray="3 3"
              />
            ),
          )}
          {!percent &&
            segments
              .filter((s) => s.length > 1)
              .map((segment, i) => (
                <Polygon
                  key={`area-${i}`}
                  points={`${segment[0].split(',')[0]},${y(0)} ${segment.join(' ')} ${segment[segment.length - 1].split(',')[0]},${y(0)}`}
                  fill={theme.win}
                  opacity={0.09}
                />
              ))}
          {segments
            .filter((s) => s.length > 1)
            .map((segment, i) => (
              <Polyline
                key={i}
                points={segment.join(' ')}
                fill="none"
                stroke={theme.win}
                strokeWidth={2.2}
                strokeLinejoin="round"
              />
            ))}
          {values.map((value, i) =>
            value !== null &&
            (i === values.length - 1 || values[i - 1] === null || values[i + 1] === null) ? (
              <Circle key={i} cx={x(i)} cy={y(value)} r={2.4} fill={theme.win} />
            ) : null,
          )}
          {selected !== undefined && selected >= 0 && selected < values.length && (
            <Line
              x1={x(selected)}
              x2={x(selected)}
              y1="0"
              y2={height - 10}
              stroke={theme.accent}
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          )}
          {selected !== undefined &&
            values[selected] !== null &&
            values[selected] !== undefined && (
              <Circle
                cx={x(selected)}
                cy={y(values[selected]!)}
                r="4.5"
                fill={theme.surface}
                stroke={theme.win}
                strokeWidth="2.5"
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
            <AppText variant="caption" tone="secondary">
              {percent ? '勝敗のある対局で表示します' : '解析した局面から表示します'}
            </AppText>
          </View>
        )}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', right: 0, top: percent ? 0 : y(0) - 8 }}
        >
          <AppText variant="small" tone="secondary">
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
              <AppText variant="small" tone="secondary" allowFontScaling={false}>
                {value > 0 ? '+' : '−'}
                {Math.abs(value)}
              </AppText>
            </View>
          ))}
      </Pressable>
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
    </View>
  );
}
