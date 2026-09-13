import React from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Stack } from 'expo-router';
import notices from '../assets/licenses.json';
import { AppText } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

export default function LicensesScreen() {
  const theme = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: 'ライセンス', headerBackTitle: '設定' }} />
      <FlashList
        testID="licenses-screen"
        data={notices}
        keyExtractor={(_, index) => String(index)}
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        renderItem={({ item, index }) => (
          <View style={{ paddingBottom: 28 }}>
            <AppText variant="headline" selectable>
              {item.packages[0]}
            </AppText>
            {item.packages.length > 1 && (
              <AppText variant="caption" tone="secondary">
                ほか{item.packages.length - 1}パッケージ
              </AppText>
            )}
            <AppText selectable style={{ marginTop: 12, fontSize: 15, lineHeight: 22 }}>
              {item.text}
            </AppText>
            {item.packages.length > 1 && (
              <View style={{ marginTop: 16 }}>
                <AppText testID={`license-packages-${index}`} variant="caption" tone="secondary">
                  対象パッケージ（{item.packages.length}）
                </AppText>
                <AppText variant="caption" selectable tone="secondary" style={{ marginTop: 4 }}>
                  {item.packages.join('\n')}
                </AppText>
              </View>
            )}
          </View>
        )}
      />
    </>
  );
}
