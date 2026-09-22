import React, { memo } from 'react';
import { Image, ImageSourcePropType, StyleSheet, View } from 'react-native';
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
  const source = piece === PieceType.KING && side === 'white' ? jewel : images[piece];
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, transform: [{ rotate: rotated ? '180deg' : '0deg' }] }}
    >
      <Image
        source={source}
        resizeMode="contain"
        fadeDuration={0}
        accessible={false}
        style={[StyleSheet.absoluteFill, { width, height }]}
      />
      {side === 'white' && (
        <Image
          source={source}
          resizeMode="contain"
          fadeDuration={0}
          accessible={false}
          tintColor="#281400"
          // Darken toward amber without a pale tint over the ink. The generated
          // sprite supplies the alpha mask and follows ownership on capture.
          style={[StyleSheet.absoluteFill, { width, height }, styles.goteTone]}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  goteTone: { opacity: 0.2 },
});
