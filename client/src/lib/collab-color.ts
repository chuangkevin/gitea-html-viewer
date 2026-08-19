/**
 * presence 調色盤。挑選原則：
 *  - 色相彼此至少差 ~35°，相鄰兩色一眼分得出來
 *  - 在 #09090b 這種近黑底上都夠亮、夠飽和
 *  - 亮度控制在中段，配白字或深字都能有足夠對比（文字顏色由亮度自動決定）
 */
export const COLLAB_PALETTE = [
  "#38bdf8", // 天藍
  "#f472b6", // 粉紅
  "#4ade80", // 綠
  "#fbbf24", // 琥珀
  "#a78bfa", // 紫
  "#fb7185", // 珊瑚紅
  "#2dd4bf", // 青綠
  "#f97316", // 橘
  "#c084fc", // 淡紫
  "#84cc16", // 黃綠
] as const;

/** 名字 → 偏好索引（0 ~ COLLAB_PALETTE.length-1）。同一個名字永遠一樣。 */
export function collabColorIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % COLLAB_PALETTE.length;
}

/** 依偏好索引與已被占用的顏色，挑一個顏色。全部被占用就回偏好索引那個。 */
export function pickCollabColor(preferredIndex: number, taken: readonly string[]): string {
  const len = COLLAB_PALETTE.length;
  const start = ((preferredIndex % len) + len) % len;
  const takenSet = new Set(taken);
  for (let i = 0; i < len; i++) {
    const color = COLLAB_PALETTE[(start + i) % len];
    if (!takenSet.has(color)) return color;
  }
  return COLLAB_PALETTE[start];
}
