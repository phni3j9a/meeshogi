import { createContext } from 'react';
import type { ImageSourcePropType } from 'react-native';
import type { PieceSetId, Side } from '@/domain/model';

export const PIECE_SETS: Record<
  PieceSetId,
  {
    id: PieceSetId;
    name: string;
    description: string;
    surfaces: Record<Side, ImageSourcePropType>;
  }
> = {
  tsuge: {
    id: 'tsuge',
    name: '黄楊',
    description: '暖かい蜂蜜色と、艶のある飴色',
    surfaces: {
      black: require('../../assets/pieces/shared/wood-sente.png'),
      white: require('../../assets/pieces/shared/wood-gote.png'),
    },
  },
  shiraki: {
    id: 'shiraki',
    name: '白木',
    description: '明るくやわらかな白木の風合い',
    surfaces: {
      black: require('../../assets/pieces/sets/shiraki/sente.png'),
      white: require('../../assets/pieces/sets/shiraki/gote.png'),
    },
  },
  sakura: {
    id: 'sakura',
    name: '桜木',
    description: 'ほのかな赤みのある桜木の色合い',
    surfaces: {
      black: require('../../assets/pieces/sets/sakura/sente.png'),
      white: require('../../assets/pieces/sets/sakura/gote.png'),
    },
  },
  seiji: {
    id: 'seiji',
    name: '青磁',
    description: '落ち着いた青緑の磁器の風合い',
    surfaces: {
      black: require('../../assets/pieces/sets/seiji/sente.png'),
      white: require('../../assets/pieces/sets/seiji/gote.png'),
    },
  },
};

export const PieceSetContext = createContext<PieceSetId>('tsuge');
