import type { RowCount } from "./types";
import { rowCountOptions } from "./types";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function interpolateRgbColors(
  from: RgbColor,
  to: RgbColor,
  length: number,
): RgbColor[] {
  return Array.from({ length }, (_, i) => ({
    r: Math.round(from.r + ((to.r - from.r) / (length - 1)) * i),
    g: Math.round(from.g + ((to.g - from.g) / (length - 1)) * i),
    b: Math.round(from.b + ((to.b - from.b) / (length - 1)) * i),
  }));
}

export function getBinColors(rowCount: RowCount) {
  const binCount = rowCount + 1;
  const isBinsEven = binCount % 2 === 0;
  const redToYellowLength = Math.ceil(binCount / 2);

  const redToYellowBg = interpolateRgbColors(
    { r: 255, g: 0, b: 63 },
    { r: 255, g: 192, b: 0 },
    redToYellowLength,
  ).map(({ r, g, b }) => `rgb(${r}, ${g}, ${b})`);

  const redToYellowShadow = interpolateRgbColors(
    { r: 166, g: 0, b: 4 },
    { r: 171, g: 121, b: 0 },
    redToYellowLength,
  ).map(({ r, g, b }) => `rgb(${r}, ${g}, ${b})`);

  return {
    background: [
      ...redToYellowBg,
      ...redToYellowBg.toReversed().slice(isBinsEven ? 0 : 1),
    ],
    shadow: [
      ...redToYellowShadow,
      ...redToYellowShadow.toReversed().slice(isBinsEven ? 0 : 1),
    ],
  };
}

export const binColorsByRowCount = rowCountOptions.reduce(
  (acc, rc) => {
    acc[rc] = getBinColors(rc);
    return acc;
  },
  {} as Record<RowCount, ReturnType<typeof getBinColors>>,
);
