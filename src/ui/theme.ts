import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

export type ThemePreference = 'system' | 'light' | 'dark';
export const ThemePreferenceContext = createContext<ThemePreference>('system');

/** Semantic roles preserve the approved warm palette in both appearances. */
export const palettes = {
  light: {
    dark: false,
    background: '#FAF9F6',
    surface: '#FFFFFF',
    inset: '#F0EEEA',
    text: '#292A27',
    secondary: '#6E6D67',
    muted: '#76756F',
    border: '#E2DFD8',
    accent: '#8B6C4D',
    accentSoft: '#F0E7DA',
    primary: '#292A27',
    onPrimary: '#FFFFFF',
    win: '#536E59',
    winSoft: '#DEE8DC',
    loss: '#965D50',
    lossSoft: '#F0DFD8',
    board: '#EDDEC2',
    boardLine: '#977B54',
    piece: '#FFF8E7',
    pieceText: '#292519',
    selection: '#D4B780',
    legal: '#718674',
    shadow: '#292A2714',
  },
  dark: {
    dark: true,
    background: '#1B1D19',
    surface: '#252821',
    inset: '#30332B',
    text: '#F3F0E7',
    secondary: '#B8B6AC',
    muted: '#8B8E80',
    border: '#41453B',
    accent: '#D5B48F',
    accentSoft: '#3E3528',
    primary: '#EEE9DB',
    onPrimary: '#252821',
    win: '#A6C3A6',
    winSoft: '#344438',
    loss: '#D9AA99',
    lossSoft: '#49352E',
    board: '#AA946F',
    boardLine: '#655135',
    piece: '#E9D9B7',
    pieceText: '#292519',
    selection: '#E8C379',
    legal: '#2D5A42',
    shadow: '#00000020',
  },
};
export type Theme = typeof palettes.light | typeof palettes.dark;
export function useTheme(): Theme {
  const preference = useContext(ThemePreferenceContext);
  const system = useColorScheme();
  return palettes[preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference];
}
export const space = { xs: 4, sm: 8, md: 16, page: 20, lg: 24, xl: 32, xxl: 48 };
export const radius = { input: 12, group: 14, sheet: 24, pill: 999 };
