import React, { useRef, useState } from 'react';
import { Alert, ScrollView, Switch, TextInput, View } from 'react-native';
import { router, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { FORMATION_LABELS, gameFormation, inferAttribution, parseKif } from '@/domain';
import {
  ANALYSIS_METHOD_LABELS,
  OPENING_LABELS,
  RESULT_LABELS,
  GameResult,
  Opening,
  ParsedGame,
  SERVICE_LABELS,
  Service,
  Side,
  SIDE_LABELS,
} from '@/domain/model';
import { useAppStore } from '@/store/app-store';
import { pickKif } from '@/platform/kif-files';
import {
  AppText,
  Button,
  Group,
  Notice,
  Row,
  SectionLabel,
  Segment,
  TextButton,
} from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { errorMessage, useChoice } from '@/ui/use-choice';

export default function ImportScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const settings = useAppStore((state) => state.settings);
  const analysisMethod = settings.analysisMethod;
  const saveImport = useAppStore((state) => state.saveImport);
  const [source, setSource] = useState(0);
  const [parsed, setParsed] = useState<ParsedGame | null>(null);
  const [service, setService] = useState<Service>('unknown');
  const [mySide, setMySide] = useState<Side | null | undefined>();
  const [autoAnalyze, setAutoAnalyze] = useState(settings.autoAnalyze);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [manualResult, setManualResult] = useState<GameResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [collision, setCollision] = useState<{ existingId: string; collision: boolean } | null>(
    null,
  );
  const raw = useRef('');
  const input = useRef<TextInput>(null);
  const allowLeave = useRef(false);
  const navigation = useNavigation();
  const choose = useChoice();
  usePreventRemove(dirty || saving, ({ data }) => {
    if (allowLeave.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (savingRef.current) {
      Alert.alert('保存中です', '保存が終わるまでお待ちください。');
      return;
    }
    Alert.alert('取り込みをキャンセルしますか？', '入力した棋譜はまだ保存されていません。', [
      { text: '編集を続ける', style: 'cancel' },
      {
        text: 'キャンセルする',
        style: 'destructive',
        onPress: () => {
          allowLeave.current = true;
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  const validate = (text: string) => {
    raw.current = text;
    setDirty(!!text.trim());
    setError('');
    setCollision(null);
    setMySide(undefined);
    setManualResult(null);
    try {
      const game = parseKif(text);
      setParsed(game);
      setService(game.service);
    } catch (e) {
      setParsed(null);
      setError(errorMessage(e));
    }
  };
  const loadText = (text: string) => {
    input.current?.setNativeProps({ text });
    validate(text);
  };
  const paste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text.trim()) {
        setError('クリップボードに棋譜がありません。対局サービスで棋譜をコピーしてください。');
        return;
      }
      loadText(text);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const pick = async () => {
    try {
      const text = await pickKif();
      if (text !== null) loadText(text);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const inferred = parsed ? inferAttribution({ ...parsed, service }, settings) : null;
  const selectedSide = mySide === undefined ? inferred?.mySide : mySide;
  const ambiguous = mySide === undefined && inferred?.attribution === 'ambiguous';
  const selectSide = async () => {
    const value = await choose('この棋譜の自分の手番', [
      { label: '先手', value: 'black' },
      { label: '後手', value: 'white' },
      { label: '自分を含まない（戦績の対象外）', value: 'none' },
    ]);
    if (value) setMySide(value === 'none' ? null : (value as Side));
  };
  const selectOpening = async () => {
    if (!parsed) return;
    const side = await choose('修正する戦型', [
      { label: '先手の戦型', value: 'black' as const },
      { label: '後手の戦型', value: 'white' as const },
    ]);
    if (!side) return;
    const opening = await choose(
      `${SIDE_LABELS[side]}の戦型`,
      (Object.keys(OPENING_LABELS) as Opening[]).map((value) => ({
        label: OPENING_LABELS[value],
        value,
      })),
    );
    if (opening)
      setParsed({
        ...parsed,
        openings: { ...parsed.openings, [side]: { ...parsed.openings[side], manual: opening } },
      });
  };
  const save = async (allowCollision = false) => {
    if (!parsed || savingRef.current || ambiguous) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const game = await saveImport(parsed, {
        service,
        mySide,
        manualResult,
        autoAnalyze,
        allowCollision,
      });
      allowLeave.current = true;
      setDirty(false);
      router.replace({ pathname: '/game/[id]', params: { id: game.id } });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof Error && 'existingId' in e)
        setCollision({
          existingId: String(e.existingId),
          collision: 'collision' in e && !!e.collision,
        });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const result = manualResult ?? parsed?.result;
  const resultLabel = result
    ? selectedSide && (result === 'black-win' || result === 'white-win')
      ? result === `${selectedSide}-win`
        ? '勝ち'
        : '負け'
      : RESULT_LABELS[result]
    : '';
  const selectResult = async () => {
    const choice = await choose('対局結果', [
      { label: '棋譜の結果に戻す', value: 'original' },
      ...Object.entries(RESULT_LABELS).map(([value, label]) => ({ value, label })),
    ]);
    if (choice) setManualResult(choice === 'original' ? null : (choice as GameResult));
  };
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: theme.background }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 20,
          paddingTop: 12,
          minHeight: 62,
        }}
      >
        <TextButton label="キャンセル" onPress={() => router.back()} disabled={saving} />
        <AppText variant="headline" style={{ flex: 1, textAlign: 'center', paddingRight: 80 }}>
          棋譜を追加
        </AppText>
      </View>
      <ScrollView
        pointerEvents={saving ? 'none' : 'auto'}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 16) + 12,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Segment labels={['貼り付け', 'ファイル']} selected={source} onChange={setSource} />
        <AppText variant="heading" style={{ marginTop: 24, marginBottom: 4 }}>
          {source === 0 ? '棋譜を貼り付け' : 'KIFファイルを選択'}
        </AppText>
        <AppText tone="secondary" variant="caption">
          {source === 0
            ? '将棋ウォーズ・棋桜からコピーした棋譜を取り込みます。'
            : '端末に保存したUTF-8・Shift_JISのKIFを読み込みます。'}
        </AppText>
        <View
          style={{
            backgroundColor: theme.surface,
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: 12,
            marginTop: 12,
            padding: 12,
          }}
        >
          <TextInput
            ref={input}
            testID="import-text"
            accessibilityLabel="KIF棋譜テキスト"
            multiline
            defaultValue=""
            autoCorrect={false}
            autoCapitalize="none"
            textAlignVertical="top"
            placeholder={'開始日時：\n先手：\n後手：\n手数----指手---------消費時間--'}
            placeholderTextColor={theme.muted}
            onChangeText={(text) => {
              raw.current = text;
              setParsed(null);
              setDirty(!!text.trim());
              setCollision(null);
            }}
            onEndEditing={() => raw.current.trim() && validate(raw.current)}
            style={{
              color: theme.text,
              fontSize: 14,
              lineHeight: 21,
              minHeight: 130,
              maxHeight: 210,
            }}
          />
          <View style={{ alignItems: 'flex-end' }}>
            <TextButton
              label={source === 0 ? 'ペースト' : 'ファイルを選ぶ'}
              icon={source === 0 ? 'clipboard' : 'file'}
              onPress={() => void (source === 0 ? paste() : pick())}
              testID={source === 0 ? 'import-paste' : 'import-file'}
            />
          </View>
        </View>
        {!parsed && dirty && (
          <TextButton label="内容を確認" onPress={() => validate(raw.current)} />
        )}
        {error && <Notice text={error} error />}
        {collision && (
          <Group style={{ padding: 12, gap: 8 }}>
            <Button
              label="保存済みの棋譜を開く"
              secondary
              onPress={() => {
                allowLeave.current = true;
                router.replace({ pathname: '/game/[id]', params: { id: collision.existingId } });
              }}
            />
            {collision.collision && (
              <Button label="別の対局として保存" onPress={() => void save(true)} busy={saving} />
            )}
          </Group>
        )}
        {parsed && (
          <>
            <AppText variant="caption" tone="win" style={{ marginTop: 12 }}>
              ✓ {parsed.moves.length}手の棋譜を読み取りました
            </AppText>
            <SectionLabel>対局情報</SectionLabel>
            <Group>
              <Row label="対局者" value={`${parsed.blackName} 対 ${parsed.whiteName}`} />
              <Row
                label="サービス"
                value={SERVICE_LABELS[service]}
                onPress={() =>
                  void choose(
                    '対局サービス',
                    (Object.keys(SERVICE_LABELS) as Service[]).map((value) => ({
                      label: SERVICE_LABELS[value],
                      value,
                    })),
                  ).then((value) => value && setService(value))
                }
              />
              <Row
                label="自分の手番"
                value={
                  ambiguous
                    ? '選択してください'
                    : selectedSide
                      ? SIDE_LABELS[selectedSide]
                      : '戦績の対象外'
                }
                onPress={() => void selectSide()}
              />
              <Row
                label="結果"
                value={`${resultLabel}${manualResult ? '（手動）' : ''}`}
                onPress={() => void selectResult()}
                testID="import-result"
              />
              <Row
                label="戦型"
                value={`${OPENING_LABELS[parsed.openings.black.manual ?? parsed.openings.black.automatic]} 対 ${OPENING_LABELS[parsed.openings.white.manual ?? parsed.openings.white.automatic]}`}
                onPress={() => void selectOpening()}
              />
              <Row label="対戦構図" value={FORMATION_LABELS[gameFormation(parsed)]} last />
            </Group>
            <AppText variant="caption" tone="secondary" style={{ marginVertical: 8 }}>
              {ambiguous
                ? '両者が登録名と一致します。自分の手番を選んでください。'
                : selectedSide
                  ? mySide === undefined
                    ? '登録した対局者名から判定しました。'
                    : '選択した手番で保存します。'
                  : '自分を含まない棋譜も保存・解析できます。戦績には含めません。'}
            </AppText>
            {manualResult && (
              <AppText variant="caption" tone="secondary" style={{ marginBottom: 12 }}>
                修正した結果を戦績に使います。KIFの書き出しでは元の棋譜を保ちます。
              </AppText>
            )}
            <Group>
              <Row label={`保存後に解析する（${ANALYSIS_METHOD_LABELS[analysisMethod]}）`} last>
                <Switch
                  value={autoAnalyze}
                  onValueChange={setAutoAnalyze}
                  trackColor={{ true: theme.win, false: theme.inset }}
                  accessibilityLabel="保存後に解析する"
                />
              </Row>
            </Group>
          </>
        )}
        <Button
          label="保存して検討する"
          testID="import-save"
          onPress={() => void save()}
          disabled={!parsed || ambiguous || !!collision}
          busy={saving}
          style={{ marginTop: 12 }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
