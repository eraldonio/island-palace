// 可复现的随机数：同一份宫殿数据在任何设备上生成相同的细节（书的颜色、植物的叶子……）
let state = 1;

export function seed(n: number) {
  state = n | 0 || 1;
}

export function seedFromString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  seed(h);
}

export function rand() {
  state |= 0; state = state + 0x6D2B79F5 | 0;
  let t = Math.imul(state ^ state >>> 15, 1 | state);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

/**
 * 随机流的存档 / 读档（原样恢复，不经过 seed 的「0 换成 1」）。
 * 摆放（决定位置 / 参数）和建几何（树的团块、岩石的棱角）共用这一条流：建几何一跑就可能
 * 用 params.seed 把流重设掉，同一段摆放代码在「建几何」和「只记录」两条路上就会分岔。
 * 所以建几何前后要存档 / 读档（见 props.ts 的 placer），摆放那边才只看摆放。
 */
export function getState(): number {
  return state;
}

export function setState(s: number) {
  state = s | 0;
}

export const rr = (a: number, b: number) => a + (b - a) * rand();
export const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
