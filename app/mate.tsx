import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { applyUsi, boardView, moveLabel } from '@/domain';
import { SIDE_LABELS } from '@/domain/model';
import { AppText, Button, EmptyState, Group, IconButton } from '@/ui/primitives';
import { ShogiBoard } from '@/ui/board';
import { getMateSession } from '@/ui/mate-session';
import { useTheme } from '@/ui/theme';

export default function MateScreen() {
  const { session: sessionId } = useLocalSearchParams<{ session: string }>();
  const session = getMateSession(sessionId);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const replay = useMemo(() => {
    if (
      !session ||
      session.proof.status !== 'proven' ||
      session.proof.side !== boardView(session.sfen).turn
    )
      return null;
    try {
      const positions = [session.sfen];
      const labels: string[] = [];
      session.proof.pv.forEach((move) => {
        labels.push(moveLabel(positions[positions.length - 1], move));
        positions.push(applyUsi(positions[positions.length - 1], move));
      });
      return { positions, labels };
    } catch {
      return null;
    }
  }, [session]);
  const total = replay?.labels.length ?? 0;
  useEffect(() => {
    if (!playing) return;
    if (ply >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setPly((value) => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [playing, ply, total]);
  const close = () => {
    setPlaying(false);
    router.back();
  };
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.background,
        paddingBottom: Math.max(insets.bottom, 16),
      }}
    >
      <Stack.Screen
        options={{
          headerLeft: () => <IconButton name="close" label="詰め手順を閉じる" onPress={close} />,
          headerBackVisible: false,
        }}
      />
      {!session || !replay ? (
        <EmptyState
          title="詰め手順が見つかりません"
          message="検討画面の証明済みバッジから開いてください。"
          action="閉じる"
          onAction={close}
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
            contentInsetAdjustmentBehavior="automatic"
          >
            <AppText
              variant="caption"
              tone="secondary"
              style={{ textAlign: 'center', marginTop: 8 }}
            >
              {session.origin}
            </AppText>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                columnGap: 12,
                rowGap: 4,
                marginVertical: 20,
              }}
            >
              <AppText variant="title">{session.proof.plies}手詰め</AppText>
              <AppText style={{ marginLeft: 'auto' }}>
                {ply} / {total}手
              </AppText>
            </View>
            <AppText variant="caption" tone="secondary" style={{ marginBottom: 10 }}>
              {SIDE_LABELS[session.proof.side]}が詰ませられます
            </AppText>
            <ShogiBoard sfen={replay.positions[ply]} bottomSide={session.bottomSide} />
            <AppText tone="secondary" style={{ marginTop: 24, marginBottom: 10 }}>
              代表手順
            </AppText>
            <Group>
              {replay.labels.map((label, index) => (
                <Pressable
                  key={index}
                  accessibilityRole="button"
                  onPress={() => {
                    setPlaying(false);
                    setPly(index + 1);
                  }}
                  style={{
                    flexDirection: 'row',
                    gap: 14,
                    alignItems: 'center',
                    minHeight: 52,
                    paddingHorizontal: 12,
                    borderBottomWidth: index < total - 1 ? 0.5 : 0,
                    borderBottomColor: theme.border,
                    backgroundColor: ply === index + 1 ? theme.accentSoft : 'transparent',
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      borderColor: theme.accent,
                      borderWidth: 1,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: ply === index + 1 ? theme.accent : 'transparent',
                    }}
                  >
                    <AppText
                      variant="caption"
                      style={{ color: ply === index + 1 ? theme.background : theme.accent }}
                    >
                      {index + 1}
                    </AppText>
                  </View>
                  <AppText style={{ flex: 1 }}>{label}</AppText>
                  <AppText variant="caption" tone="secondary">
                    {index === total - 1 ? '詰み' : index % 2 === 0 ? '王手' : ''}
                  </AppText>
                </Pressable>
              ))}
            </Group>
            <AppText variant="caption" tone="secondary" style={{ marginTop: 12 }}>
              すべての合法な応手に対する詰みを確認済みです。ここでは代表的な手順を表示しています。
            </AppText>
          </ScrollView>
          <View
            style={{ flexDirection: 'row', paddingHorizontal: 20, gap: 8, alignItems: 'center' }}
          >
            <IconButton
              name="previous"
              label="一手戻る"
              disabled={ply === 0}
              onPress={() => {
                setPlaying(false);
                setPly((value) => value - 1);
              }}
            />
            <Button
              label={playing ? '再生を停止' : '手順を再生'}
              icon={playing ? 'pause' : 'play'}
              onPress={() => {
                if (ply === total) setPly(0);
                setPlaying((value) => !value);
              }}
              style={{ flex: 1 }}
            />
            <IconButton
              name="next"
              label="一手進む"
              disabled={ply === total}
              onPress={() => {
                setPlaying(false);
                setPly((value) => value + 1);
              }}
            />
          </View>
        </>
      )}
    </View>
  );
}
