import type { PalaceDoc } from './schema';
import type { PalaceWorld } from './world';

/** 简单的键值存储 */
export interface Prefs {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * 宿主适配器：core 只通过这个接口与宿主交互。
 * 所有方法都是可选的，缺失时对应的 UI 会自动隐藏。
 */
export interface HostAdapter {
  /** 界面语言（zh-CN、en……，宿主自己的语言设置）；不给时按浏览器语言 */
  locale?: string;
  /** 是否手机 / 平板（用来挑画质档位）；不给时按是否触屏猜 */
  isMobile?: boolean;
  /** 本机的界面偏好（画质等）；不给时只在这次打开期间记住 */
  prefs?: Prefs;
  /** 宫殿数据发生变化（搭建 / 改名，或新建了一座宫殿），由宿主持久化 */
  onDocChange?(doc: PalaceDoc): void;
  /** 世界数据（宫殿的摆放、屋顶）发生变化，由宿主持久化 */
  onWorldChange?(world: PalaceWorld): void;
  /** 用户删除了一座宫殿 */
  onDocDelete?(id: string): void;
  /** 进入某座宫殿（palaceId）或回到小镇（null），可用于更新页签标题 */
  onLocationChange?(palaceId: string | null, name: string): void;
  /** 轻提示 */
  notify?(message: string, type?: 'info' | 'error'): void;
  /**
   * 保存一个媒体文件（照片已压缩、模型 .glb）。id 由内核按内容算好（见 mediaIdOf），
   * 形如 <32 位十六进制>.<扩展名>；同一个 id 内容一定相同，已经存在时可以直接跳过。
   */
  saveMedia?(data: Blob, id: string): Promise<void>;
  /** 读取媒体，返回可以直接用作 <img src> 的地址 */
  loadMedia?(id: string): Promise<string>;
}
