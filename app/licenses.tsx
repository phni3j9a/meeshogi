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
      <Stack.Screen options={{ title: 'ライセンス' }} />
      <FlashList
        data={notices}
        keyExtractor={(_, index) => String(index)}
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        renderItem={({ item }) => (
          <View style={{ paddingBottom: 28 }}>
            <AppText variant="headline" selectable>
              {item.packages.join(', ')}
            </AppText>
            <AppText variant="caption" selectable tone="secondary" style={{ marginTop: 10 }}>
              {item.text}
            </AppText>
          </View>
        )}
      />
    </>
  );
}
