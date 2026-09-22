import React, { memo, useContext } from 'react';
import { Image, ImageSourcePropType, View } from 'react-native';
import { PieceType } from 'tsshogi';
import type { PieceSetId, Side } from '@/domain/model';
import { PIECE_SETS, PieceSetContext } from './piece-sets';

// Static requires keep every generated wood surface and ink glyph in the bundle.
const glyphs: Record<PieceType, ImageSourcePropType> = {
  [PieceType.PAWN]: require('../../assets/pieces/glyphs/pawn.png'),
  [PieceType.LANCE]: require('../../assets/pieces/glyphs/lance.png'),
  [PieceType.KNIGHT]: require('../../assets/pieces/glyphs/knight.png'),
  [PieceType.SILVER]: require('../../assets/pieces/glyphs/silver.png'),
  [PieceType.GOLD]: require('../../assets/pieces/glyphs/gold.png'),
  [PieceType.BISHOP]: require('../../assets/pieces/glyphs/bishop.png'),
  [PieceType.ROOK]: require('../../assets/pieces/glyphs/rook.png'),
  [PieceType.KING]: require('../../assets/pieces/glyphs/king.png'),
  [PieceType.PROM_PAWN]: require('../../assets/pieces/glyphs/promoted-pawn.png'),
  [PieceType.PROM_LANCE]: require('../../assets/pieces/glyphs/promoted-lance.png'),
  [PieceType.PROM_KNIGHT]: require('../../assets/pieces/glyphs/promoted-knight.png'),
  [PieceType.PROM_SILVER]: require('../../assets/pieces/glyphs/promoted-silver.png'),
  [PieceType.HORSE]: require('../../assets/pieces/glyphs/horse.png'),
  [PieceType.DRAGON]: require('../../assets/pieces/glyphs/dragon.png'),
};
const jewel = require('../../assets/pieces/glyphs/jewel.png');
// Every surface uses the same 236 × 272 frame, including transparent margins.
const woodAspect = 236 / 272;

/** The enclosing square/hand button supplies the accessible piece name. */
export const PieceImage = memo(function PieceImage({
  piece,
  side,
  width,
  height,
  rotated = false,
  pieceSet,
}: {
  piece: PieceType;
  side: Side;
  width: number;
  height: number;
  rotated?: boolean;
  pieceSet?: PieceSetId;
}) {
  const selectedSet = useContext(PieceSetContext);
  const surface = PIECE_SETS[pieceSet ?? selectedSet].surfaces[side];
  const woodWidth = Math.min(width, height * woodAspect);
  const woodHeight = woodWidth / woodAspect;
  const woodLeft = (width - woodWidth) / 2;
  const woodTop = (height - woodHeight) / 2;
  const glyphWidth = woodWidth * 0.74;
  const glyphHeight = woodHeight * 0.7;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, transform: [{ rotate: rotated ? '180deg' : '0deg' }] }}
    >
      <Image
        source={surface}
        resizeMode="contain"
        fadeDuration={0}
        accessible={false}
        style={{
          position: 'absolute',
          left: woodLeft,
          top: woodTop,
          width: woodWidth,
          height: woodHeight,
        }}
      />
      <Image
        source={piece === PieceType.KING && side === 'white' ? jewel : glyphs[piece]}
        resizeMode="contain"
        fadeDuration={0}
        accessible={false}
        style={{
          position: 'absolute',
          left: woodLeft + (woodWidth - glyphWidth) / 2,
          top: woodTop + woodHeight * 0.56 - glyphHeight / 2,
          width: glyphWidth,
          height: glyphHeight,
        }}
      />
    </View>
  );
});
