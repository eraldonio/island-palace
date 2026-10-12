import type { AiAdapter, ChatMessage } from './host';
import { t } from './i18n';

/* =====================================================================
 * OpenAI 兼容接口的大模型客户端（与宿主无关）：只服务拍照识物（看图聊天）。
 * 网络请求交给宿主（浏览器里由应用自己发），这样没有跨域限制，手机上也能用。
 * Key 只存在宿主的配置里，不进宫殿数据。
 * ===================================================================== */

export interface OpenAiConfig {
  textBase: string;
  textKey: string;
  textModel: string;
  /** 看图（拍照识物）用的模型；留空时用文字模型 */
  visionModel: string;
}

export const OPENAI_DEFAULTS: OpenAiConfig = {
  textBase: 'https://api.openai.com/v1',
  textKey: '',
  textModel: 'gpt-4o-mini',
  visionModel: '',
};

/** 宿主提供的 HTTP：POST JSON，返回状态码和响应文本 */
export type HttpPost = (url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) => Promise<{ status: number; text: string }>;

export const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + '/' + path;

/** 本机 / 内网地址（例如本地的 Ollama）：不需要 Key */
export function isLocalUrl(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local') || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

/** 推理模型会把思考过程放在  thinking 里 */
export const stripThink = (s: string) => s.replace(/ thinking[\s\S]*?<\/think>/g, '').trim();

export function apiErrorText(status: number, body: string) {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message || j?.message || j?.msg || j?.error;
    if (m) return `${status} ${typeof m === 'string' ? m : JSON.stringify(m)}`;
  } catch { /* 不是 JSON */ }
  return `HTTP ${status} ${body.slice(0, 160)}`;
}

export function createOpenAiAdapter(config: () => OpenAiConfig, post: HttpPost): AiAdapter & { test(): Promise<string> } {
  const call = async (base: string, key: string, path: string, body: unknown, timeout: number) => {
    if (!key && !isLocalUrl(base)) throw new Error(t('还没有填写模型接口的 API Key（应用设置）'));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await post(joinUrl(base, path), headers, body, timeout);
    if (res.status >= 400) throw new Error(apiErrorText(res.status, res.text || ''));
    try { return JSON.parse(res.text); } catch { throw new Error(t('接口返回的不是 JSON：') + String(res.text).slice(0, 120)); }
  };
  const vision = () => config().visionModel || config().textModel;
  const chat = async (messages: ChatMessage[], temperature = .8) => {
    const c = config();
    const model = messages.some(m => Array.isArray(m.content)) ? vision() : c.textModel;
    const data = await call(c.textBase, c.textKey, 'chat/completions', { model, messages, temperature }, 120e3);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(t('模型没有返回内容'));
    return stripThink(String(text));
  };
  return {
    chat: (messages, opts) => chat(messages, opts?.temperature ?? .8),
    visionEnabled: () => !!(config().textKey || isLocalUrl(config().textBase)) && !!vision(),
    test: () => chat([{ role: 'user', content: t('只回复两个字：你好') }], 0),
  };
}
