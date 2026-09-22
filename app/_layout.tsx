import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { useAppStore } from '@/store/app-store';
import { ThemePreferenceContext, useTheme } from '@/ui/theme';
import { AppText, Button } from '@/ui/primitives';
import { PieceSetContext } from '@/ui/piece-sets';

export const unstable_settings = { anchor: '(tabs)' };
function Navigation() {
  const theme = useTheme();
  const ready = useAppStore((state) => state.ready);
  const error = useAppStore((state) => state.error);
  const initialize = useAppStore((state) => state.initialize);
  useEffect(() => {
    void initialize().catch(() => undefined);
  }, [initialize]);
  if (!ready)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.background,
          justifyContent: 'center',
          alignItems: 'center',
          gap: 16,
          padding: 32,
        }}
      >
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
        {error ? (
          <>
            <AppText>{error}</AppText>
            <Button
              label="もう一度読み込む"
              onPress={() => void initialize().catch(() => undefined)}
            />
          </>
        ) : (
          <>
            <ActivityIndicator color={theme.accent} />
            <AppText tone="secondary">棋譜を読み込んでいます</AppText>
          </>
        )}
      </View>
    );
  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.accent,
          headerTitleStyle: { color: theme.text, fontSize: 17 },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="import"
          options={{
            presentation: 'formSheet',
            headerShown: false,
            sheetAllowedDetents: [1],
            sheetGrabberVisible: true,
            sheetCornerRadius: 24,
          }}
        />
        <Stack.Screen name="game/[id]" options={{ title: '検討', headerBackTitle: '戻る' }} />
        <Stack.Screen
          name="mate"
          options={{ title: '詰め手順', presentation: 'fullScreenModal' }}
        />
        <Stack.Screen name="opening/[id]" options={{ title: '戦型別', headerBackTitle: '戦績' }} />
        <Stack.Screen
          name="player-names"
          options={{ title: '対局者名', headerBackTitle: '設定' }}
        />
        <Stack.Screen name="piece-sets" options={{ title: '駒セット', headerBackTitle: '設定' }} />
        <Stack.Screen
          name="game-info/[id]"
          options={{ title: '対局情報', headerBackTitle: '検討' }}
        />
      </Stack>
    </>
  );
}
export default function RootLayout() {
  const preference = useAppStore((state) => state.settings.theme);
  const pieceSet = useAppStore((state) => state.settings.pieceSet);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemePreferenceContext.Provider value={preference}>
            <PieceSetContext.Provider value={pieceSet}>
              <ActionSheetProvider>
                <Navigation />
              </ActionSheetProvider>
            </PieceSetContext.Provider>
          </ThemePreferenceContext.Provider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
