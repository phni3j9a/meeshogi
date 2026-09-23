import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PieceType } from 'tsshogi';
import { PIECE_SET_IDS, PieceSetId, Side } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { PieceImage } from '@/ui/piece-image';
import { PIECE_SETS } from '@/ui/piece-sets';
import { AppText, Icon, Notice, PageScroll } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { errorMessage } from '@/ui/use-choice';

const previewPieces = [PieceType.PAWN, PieceType.KING, PieceType.HORSE];

export default function PieceSetsScreen() {
  const selected = useAppStore((state) => state.settings.pieceSet);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const saving = useRef(false);
  const [pending, setPending] = useState<PieceSetId | null>(null);
  const [failure, setFailure] = useState<{ id: PieceSetId; message: string } | null>(null);

  const selectPieceSet = async (id: PieceSetId) => {
    if (saving.current || id === selected) return;
    saving.current = true;
    setPending(id);
    setFailure(null);
    try {
      await updateSettings({ pieceSet: id });
    } catch (error) {
      setFailure({ id, message: errorMessage(error) });
    } finally {
      saving.current = false;
      setPending(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }} testID="piece-sets-screen">
      <PageScroll bottom={Math.max(32, insets.bottom + 16)}>
        <View style={styles.content}>
          <AppText variant="caption" tone="secondary" style={styles.intro}>
            見た目を選べます。変更は自動で保存されます。
          </AppText>
          <View style={styles.sets} accessibilityRole="radiogroup" accessibilityLabel="駒セット">
            {PIECE_SET_IDS.map((id) => {
              const set = PIECE_SETS[id];
              const checked = selected === id;
              const busy = pending === id;
              return (
                <View key={id}>
                  <Pressable
                    testID={`piece-set-${id}`}
                    accessibilityRole="radio"
                    accessibilityLabel={`${set.name}。${set.description}`}
                    accessibilityHint={checked ? '現在の駒セットです' : '選ぶと自動で保存されます'}
                    accessibilityState={{ checked, disabled: pending !== null, busy }}
                    disabled={pending !== null}
                    onPress={() => void selectPieceSet(id)}
                    style={({ pressed }) => [
                      styles.card,
                      {
                        backgroundColor: pressed ? theme.inset : theme.surface,
                        borderColor: checked ? theme.win : theme.border,
                      },
                    ]}
                  >
                    <View style={styles.heading}>
                      <AppText variant="headline" style={{ flex: 1 }}>
                        {set.name}
                      </AppText>
                      {busy ? (
                        <View
                          style={styles.status}
                          testID="piece-set-saving"
                          accessibilityLiveRegion="polite"
                        >
                          <ActivityIndicator size="small" color={theme.win} />
                          <AppText variant="caption" tone="secondary">
                            保存中
                          </AppText>
                        </View>
                      ) : checked ? (
                        <View style={styles.status}>
                          <AppText variant="caption" tone="win">
                            選択中
                          </AppText>
                          <Icon name="check" size={18} color={theme.win} />
                        </View>
                      ) : null}
                    </View>
                    <AppText variant="caption" tone="secondary" style={styles.description}>
                      {set.description}
                    </AppText>
                    <View style={[styles.previews, { backgroundColor: theme.inset }]}>
                      {(['black', 'white'] as const).map((side: Side) => (
                        <View key={side} style={styles.side}>
                          <AppText variant="small" tone="secondary" style={{ textAlign: 'center' }}>
                            {side === 'black' ? '▲ 先手' : '△ 後手'}
                          </AppText>
                          <View style={styles.pieces}>
                            {previewPieces.map((piece) => (
                              <PieceImage
                                key={piece}
                                piece={piece}
                                side={side}
                                pieceSet={id}
                                width={32}
                                height={39}
                              />
                            ))}
                          </View>
                        </View>
                      ))}
                    </View>
                  </Pressable>
                  {failure?.id === id && (
                    <View testID="piece-set-error">
                      <Notice
                        text={`駒セットを保存できませんでした。${failure.message}`}
                        error
                        action="再試行"
                        onAction={() => void selectPieceSet(id)}
                      />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </PageScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 500, alignSelf: 'center' },
  intro: { marginTop: 10, marginBottom: 16 },
  sets: { gap: 12 },
  card: { minHeight: 160, borderWidth: 1, borderRadius: 14, padding: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 25 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  description: { marginTop: 3, marginBottom: 12 },
  previews: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 6,
    paddingVertical: 9,
    borderRadius: 8,
  },
  side: { flex: 1, minWidth: 0, gap: 5 },
  pieces: { flexDirection: 'row', justifyContent: 'center', gap: 3 },
});
