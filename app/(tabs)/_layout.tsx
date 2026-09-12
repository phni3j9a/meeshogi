import React from 'react';
import { Tabs } from 'expo-router';
import { Icon } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';

export default function TabLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.background, borderTopColor: theme.border },
        tabBarLabelStyle: { fontSize: 11 },
        sceneStyle: { backgroundColor: theme.background },
        animation: 'none',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: '棋譜', tabBarIcon: ({ color }) => <Icon name="games" color={color} /> }}
      />
      <Tabs.Screen
        name="statistics"
        options={{ title: '戦績', tabBarIcon: ({ color }) => <Icon name="stats" color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '設定',
          tabBarIcon: ({ color }) => <Icon name="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}
