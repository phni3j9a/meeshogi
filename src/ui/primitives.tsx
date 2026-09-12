import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  ColorValue,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import Svg, { Circle, Path } from 'react-native-svg';
import { radius, useTheme } from './theme';

const symbols = {
  add: ['plus', 'add'],
  search: ['magnifyingglass', 'search'],
  next: ['chevron.right', 'chevron_right'],
  previous: ['chevron.left', 'chevron_left'],
  close: ['xmark', 'close'],
  more: ['ellipsis', 'more_horiz'],
  games: ['doc.text', 'description'],
  stats: ['chart.bar', 'bar_chart'],
  settings: ['gearshape', 'settings'],
  person: ['person', 'person'],
  filter: ['slider.horizontal.3', 'tune'],
  clipboard: ['doc.on.clipboard', 'content_paste'],
  file: ['doc', 'description'],
  share: ['square.and.arrow.up', 'ios_share'],
  favorite: ['star', 'star'],
  favoriteFill: ['star.fill', 'star'],
  check: ['checkmark', 'check'],
  warning: ['exclamationmark.circle', 'error_outline'],
  first: ['backward.end.fill', 'skip_previous'],
  last: ['forward.end.fill', 'skip_next'],
  play: ['play.fill', 'play_arrow'],
  pause: ['pause.fill', 'pause'],
  branch: ['arrow.triangle.branch', 'fork_right'],
  flip: ['arrow.triangle.2.circlepath', 'flip_camera_android'],
  down: ['chevron.down', 'expand_more'],
  delete: ['trash', 'delete_outline'],
  info: ['info.circle', 'info'],
} as const;
export type IconName = keyof typeof symbols;
export function Icon({
  name,
  size = 23,
  color,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
}) {
  const theme = useTheme();
  const [ios, android] = symbols[name];
  return (
    <SymbolView
      name={{ ios, android, web: android } as SymbolViewProps['name']}
      size={size}
      tintColor={color ?? theme.accent}
      style={{ width: size, height: size }}
    />
  );
}

const typeStyles: Record<string, TextStyle> = {
  body: { fontSize: 17, lineHeight: 25 },
  title: { fontSize: 32, lineHeight: 40, fontWeight: '700' },
  heading: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 25, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 20 },
  small: { fontSize: 11, lineHeight: 16 },
  metric: { fontSize: 56, lineHeight: 64, fontWeight: '700', fontVariant: ['tabular-nums'] },
};
export function AppText({
  variant = 'body',
  tone,
  style,
  ...props
}: TextProps & {
  variant?: keyof typeof typeStyles;
  tone?: 'secondary' | 'muted' | 'accent' | 'win' | 'loss';
}) {
  const theme = useTheme();
  return (
    <Text
      {...props}
      style={[typeStyles[variant], { color: tone ? theme[tone] : theme.text }, style]}
    />
  );
}
export function BrandMark({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.brand} accessibilityLabel="meeshogi">
      <Svg width={25} height={29} viewBox="0 0 32 38" accessibilityElementsHidden>
        <Path
          d="M5 36 10 21C7 17 8 11 11 8 12 4 17 3 21 6 25 6 25 11 29 13L26 17 22 17 21 23 26 36"
          fill="none"
          stroke={theme.accent}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx="20" cy="11" r="1.5" fill={theme.accent} />
      </Svg>
      {!compact && (
        <AppText variant="headline" tone="accent" style={{ letterSpacing: 0.2 }}>
          meeshogi
        </AppText>
      )}
    </View>
  );
}
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.pageHeader}>
      <BrandMark />
      <View style={styles.titleRow}>
        <AppText variant="title" accessibilityRole="header">
          {title}
        </AppText>
        <View style={styles.actions}>{children}</View>
      </View>
    </View>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  disabled,
  filled,
  testID,
  size = 23,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  testID?: string;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: filled ? theme.primary : 'transparent',
          opacity: disabled ? 0.28 : pressed ? 0.45 : 1,
        },
      ]}
    >
      <Icon name={name} size={size} color={filled ? theme.onPrimary : theme.accent} />
    </Pressable>
  );
}
export function Button({
  label,
  onPress,
  secondary,
  disabled,
  busy,
  icon,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: secondary ? theme.surface : theme.primary,
          borderColor: secondary ? theme.border : theme.primary,
          opacity: disabled ? 0.35 : pressed ? 0.72 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? theme.accent : theme.onPrimary} />
      ) : (
        icon && <Icon name={icon} color={secondary ? theme.accent : theme.onPrimary} size={20} />
      )}
      <AppText
        variant="headline"
        style={{ color: secondary ? theme.accent : theme.onPrimary, textAlign: 'center' }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
export function TextButton({
  label,
  onPress,
  icon,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, { opacity: disabled ? 0.3 : pressed ? 0.45 : 1 }]}
    >
      {icon && <Icon name={icon} size={19} />}
      <AppText variant="headline" style={{ color: theme.accent }}>
        {label}
      </AppText>
    </Pressable>
  );
}
export function Segment({
  labels,
  selected,
  onChange,
  testID,
}: {
  labels: string[];
  selected: number;
  onChange: (index: number) => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <SegmentedControl
      testID={testID}
      values={labels}
      selectedIndex={selected}
      onChange={(event) => onChange(event.nativeEvent.selectedSegmentIndex)}
      appearance={theme.dark ? 'dark' : 'light'}
      tintColor={theme.surface}
      backgroundColor={theme.inset}
      fontStyle={{ color: theme.secondary, fontSize: 15 }}
      activeFontStyle={{ color: theme.text, fontWeight: '600', fontSize: 15 }}
      style={{ height: 38, marginVertical: 4 }}
    />
  );
}
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.group, { backgroundColor: theme.surface, borderColor: theme.border }, style]}
    >
      {children}
    </View>
  );
}
export function Row({
  label,
  value,
  children,
  onPress,
  icon,
  last = false,
  testID,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
  onPress?: () => void;
  icon?: IconName;
  last?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const content = (
    <>
      {icon && <Icon name={icon} color={theme.text} />}
      <AppText style={{ flex: 1 }}>{label}</AppText>
      {children ??
        (value && (
          <AppText tone="secondary" style={{ flexShrink: 1, textAlign: 'right' }}>
            {value}
          </AppText>
        ))}
      {onPress && <Icon name="next" color={theme.muted} size={18} />}
    </>
  );
  const style: ViewStyle = {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomColor: theme.border,
    borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
  };
  return onPress ? (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [style, { backgroundColor: pressed ? theme.inset : 'transparent' }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={style}>{content}</View>
  );
}
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <AppText tone="secondary" style={{ marginTop: 24, marginBottom: 8 }} accessibilityRole="header">
      {children}
    </AppText>
  );
}
export function Notice({
  text,
  error = false,
  action,
  onAction,
}: {
  text: string;
  error?: boolean;
  action?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.notice, { backgroundColor: error ? theme.lossSoft : theme.accentSoft }]}
    >
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <Icon
          name={error ? 'warning' : 'info'}
          size={19}
          color={error ? theme.loss : theme.accent}
        />
        <AppText variant="caption" style={{ flex: 1, color: error ? theme.loss : theme.text }}>
          {text}
        </AppText>
      </View>
      {action && onAction && <TextButton label={action} onPress={onAction} />}
    </View>
  );
}
export function EmptyState({
  title,
  message,
  action,
  onAction,
  icon = 'games',
}: {
  title: string;
  message: string;
  action?: string;
  onAction?: () => void;
  icon?: IconName;
}) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: theme.accentSoft }]}>
        <Icon name={icon} size={35} />
      </View>
      <AppText variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      <AppText tone="secondary" style={{ textAlign: 'center', maxWidth: 290 }}>
        {message}
      </AppText>
      {action && onAction && (
        <Button label={action} onPress={onAction} style={{ alignSelf: 'stretch', marginTop: 8 }} />
      )}
    </View>
  );
}
export function PageScroll({ children, bottom = 32 }: { children: ReactNode; bottom?: number }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: bottom }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  pageHeader: { paddingTop: 16, gap: 10, paddingBottom: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  actions: { flexDirection: 'row', gap: 4 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  button: {
    minHeight: 50,
    borderWidth: 1,
    borderRadius: radius.group,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  textButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  group: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.group,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  notice: { borderRadius: radius.input, padding: 12, gap: 2, marginVertical: 8 },
  empty: { paddingHorizontal: 20, paddingVertical: 48, alignItems: 'center', gap: 16 },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
});
