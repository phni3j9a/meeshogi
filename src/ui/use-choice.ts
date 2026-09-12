import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTheme } from './theme';

export function useChoice() {
  const { showActionSheetWithOptions } = useActionSheet();
  const theme = useTheme();
  return <T>(title: string, choices: { label: string; value: T; destructive?: boolean }[]) =>
    new Promise<T | undefined>((resolve) => {
      showActionSheetWithOptions(
        {
          title,
          options: [...choices.map((choice) => choice.label), 'キャンセル'],
          cancelButtonIndex: choices.length,
          destructiveButtonIndex: choices.findIndex((choice) => choice.destructive),
          tintColor: theme.accent,
          containerStyle: { backgroundColor: theme.surface },
          textStyle: { color: theme.text },
          titleTextStyle: { color: theme.secondary },
        },
        (index) =>
          resolve(
            index === undefined || index === choices.length ? undefined : choices[index]?.value,
          ),
      );
    });
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。';
}
