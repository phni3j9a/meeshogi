import React, { useRef, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { Stack, router, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { inferAttribution } from '@/domain';
import { SERVICE_LABELS, Service, Settings, SIDE_LABELS } from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { AppText, Group, Notice, Row, SectionLabel, TextButton } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { errorMessage } from '@/ui/use-choice';

export default function PlayerNamesScreen() {
  const settings = useAppStore((state) => state.settings);
  const games = useAppStore((state) => state.games);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const draft = useRef<Settings['playerNames']>({
    shogiwars: settings.playerNames.shogiwars.length ? [...settings.playerNames.shogiwars] : [''],
    kiou: settings.playerNames.kiou.length ? [...settings.playerNames.kiou] : [''],
    unknown: [...settings.playerNames.unknown],
  });
  const [preview, setPreview] = useState(draft.current);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const theme = useTheme();
  const navigation = useNavigation();
  const allowLeave = useRef(false);
  const editedSettings = { ...settings, playerNames: preview };
  const affected = games.filter(
    (game) =>
      game.attribution !== 'manual' &&
      inferAttribution(game, editedSettings).mySide !== game.mySide,
  );
  const example = affected[0] ?? games[0];
  const exampleSide = example ? inferAttribution(example, editedSettings).mySide : null;
  usePreventRemove(dirty || busy, ({ data }) => {
    if (allowLeave.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (busyRef.current) {
      Alert.alert('保存中です', '保存が終わるまでお待ちください。');
      return;
    }
    Alert.alert('変更を保存せずに戻りますか？', '対局者名の変更はまだ保存されていません。', [
      { text: '編集を続ける', style: 'cancel' },
      {
        text: '保存せずに戻る',
        style: 'destructive',
        onPress: () => {
          allowLeave.current = true;
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  const persist = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await updateSettings({ playerNames: structuredClone(draft.current) });
      allowLeave.current = true;
      setDirty(false);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const save = () => {
    if (busyRef.current) return;
    if (!dirty) {
      router.back();
      return;
    }
    const changed = games.filter(
      (game) =>
        game.attribution !== 'manual' &&
        inferAttribution(game, { ...settings, playerNames: draft.current }).mySide !== game.mySide,
    ).length;
    if (changed)
      Alert.alert(
        '既存の棋譜にも反映しますか？',
        `${changed}局の自分の手番・戦績が変わります。手動で選んだ手番は保ちます。`,
        [
          { text: '確認に戻る', style: 'cancel' },
          { text: '保存して反映', onPress: () => void persist() },
        ],
      );
    else void persist();
  };
  return (
    <KeyboardAwareScrollView
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <TextButton
              label={busy ? '保存中' : '完了'}
              onPress={save}
              disabled={busy}
              testID="names-save"
            />
          ),
        }}
      />
      <AppText variant="heading" style={{ marginBottom: 12 }}>
        棋譜で使う名前
      </AppText>
      <AppText tone="secondary">
        対局サービスで使っている名前を登録すると、先後と勝敗を自動で判定できます。
      </AppText>
      {error && <Notice text={error} error />}
      {(
        ['shogiwars', 'kiou', ...(draft.current.unknown.length ? ['unknown'] : [])] as Service[]
      ).map((service) => (
        <View key={service}>
          <SectionLabel>{SERVICE_LABELS[service]}</SectionLabel>
          <Group>
            {draft.current[service].map((value, index) => (
              <View
                key={`${service}-${index}`}
                style={{
                  minHeight: 54,
                  paddingHorizontal: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  borderBottomColor: theme.border,
                  borderBottomWidth: index < draft.current[service].length - 1 ? 0.5 : 0,
                }}
              >
                <AppText>対局者名</AppText>
                <TextInput
                  testID={index === 0 ? `names-${service}` : `names-${service}-${index}`}
                  accessibilityLabel={`${SERVICE_LABELS[service]}の対局者名${index + 1}`}
                  defaultValue={value}
                  editable={!busy}
                  placeholder="名前を入力"
                  placeholderTextColor={theme.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="nickname"
                  clearButtonMode="while-editing"
                  returnKeyType="done"
                  onChangeText={(text) => {
                    draft.current[service][index] = text;
                    setDirty(true);
                  }}
                  onBlur={() => setPreview(structuredClone(draft.current))}
                  onSubmitEditing={() => setPreview(structuredClone(draft.current))}
                  style={{ flex: 1, color: theme.text, fontSize: 17, minHeight: 52 }}
                />
              </View>
            ))}
          </Group>
          <TextButton
            label="名前を追加"
            disabled={busy}
            icon="add"
            onPress={() => {
              draft.current[service].push('');
              setPreview(structuredClone(draft.current));
              setDirty(true);
            }}
          />
        </View>
      ))}
      <SectionLabel>既存の棋譜への反映</SectionLabel>
      <AppText variant="caption" tone="secondary">
        {games.length
          ? `${affected.length}局の手番判定が変わります。手動で選んだ手番は保ちます。`
          : '棋譜を追加すると、登録名から自分の手番を判定します。'}
      </AppText>
      {example && (
        <>
          <SectionLabel>判定の例</SectionLabel>
          <Group>
            {(['black', 'white'] as const).map((side, index) => (
              <Row
                key={side}
                label={`${SIDE_LABELS[side]}　${side === 'black' ? example.blackName : example.whiteName}`}
                value={exampleSide === side ? 'あなた' : ''}
                last={index === 1}
              />
            ))}
          </Group>
          {!exampleSide && (
            <AppText variant="caption" tone="secondary" style={{ paddingTop: 8 }}>
              自分の戦績には含まれません。
            </AppText>
          )}
        </>
      )}
    </KeyboardAwareScrollView>
  );
}
