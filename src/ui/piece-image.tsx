import React, { memo } from 'react';
import { Image, ImageSourcePropType } from 'react-native';
import { PieceType } from 'tsshogi';
import { Side } from '@/domain/model';

// Keep the static requires explicit so Metro bundles every generated piece.
const images: Record<PieceType, ImageSourcePropType> = {
  [PieceType.PAWN]: require('../../assets/pieces/pawn.png'),
  [PieceType.LANCE]: require('../../assets/pieces/lance.png'),
  [PieceType.KNIGHT]: require('../../assets/pieces/knight.png'),
  [PieceType.SILVER]: require('../../assets/pieces/silver.png'),
  [PieceType.GOLD]: require('../../assets/pieces/gold.png'),
  [PieceType.BISHOP]: require('../../assets/pieces/bishop.png'),
  [PieceType.ROOK]: require('../../assets/pieces/rook.png'),
  [PieceType.KING]: require('../../assets/pieces/king.png'),
  [PieceType.PROM_PAWN]: require('../../assets/pieces/promoted-pawn.png'),
  [PieceType.PROM_LANCE]: require('../../assets/pieces/promoted-lance.png'),
  [PieceType.PROM_KNIGHT]: require('../../assets/pieces/promoted-knight.png'),
  [PieceType.PROM_SILVER]: require('../../assets/pieces/promoted-silver.png'),
  [PieceType.HORSE]: require('../../assets/pieces/horse.png'),
  [PieceType.DRAGON]: require('../../assets/pieces/dragon.png'),
};
const jewel = require('../../assets/pieces/jewel.png');

/** The enclosing square/hand button supplies the accessible piece name. */
export const PieceImage = memo(function PieceImage({
  piece,
  side,
  width,
  height,
  rotated = false,
}: {
  piece: PieceType;
  side: Side;
  width: number;
  height: number;
  rotated?: boolean;
}) {
  return (
    <Image
      source={piece === PieceType.KING && side === 'white' ? jewel : images[piece]}
      resizeMode="contain"
      fadeDuration={0}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width, height, transform: [{ rotate: rotated ? '180deg' : '0deg' }] }}
    />
  );
});
