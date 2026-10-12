import { createOpenAiAdapter, OPENAI_DEFAULTS, type AiAdapter, type HttpPost, type OpenAiConfig } from '../src';
import { html } from '../src/dom';
import { L } from './samples';

/* =====================================================================
 * 大模型接口：本机配置 + 设置对话框
 * 独立网页版没有宿主的设置面板，接口地址 / API Key / 模型 / 识图模型 / 温度都存在
 * 浏览器的 localStorage 里，页面右上角的「AI 设置」按钮打开这个对话框。
 * 什么都没配之前 visionEnabled() 是 false，拍照识物的按钮不会出现。
 * ===================================================================== */

/** 本机保存的接口配置；temperature 不进 OpenAiConfig，调用时用 opts 传给模型 */
export interface AiSettings extends OpenAiConfig {
  temperature: number;
}

/** 只存在这台浏览器里，不进宫殿数据 */
const KEY = 'island-palace:ai';
export const AI_DEFAULTS: AiSettings = { ...OPENAI_DEFAULTS, temperature: .8 };

export function loadAiSettings(): AiSettings {
  let stored: Partial<AiSettings> = {};
  // 这份配置是我们自己写进去的，形状由 saveAiSettings 保证
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<AiSettings>; } catch { /* 坏了就用默认值 */ }
  return { ...AI_DEFAULTS, ...stored };
}

export function saveAiSettings(s: AiSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** 浏览器直接发请求：非 2xx 也照常返回，错误文本交给 apiErrorText 渲染 */
const httpPost: HttpPost = async (url, headers, body, timeoutMs) => {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    return { status: res.status, text: await res.text() };
  } finally { window.clearTimeout(timer); }
};

/** 按当前配置建一个客户端；配置每次调用时重新读，所以改完设置立刻生效 */
export function createAiClient(settings: () => AiSettings): AiAdapter & { test(): Promise<string> } {
  const base = createOpenAiAdapter(settings, httpPost);
  return {
    chat: (messages, opts) => base.chat(messages, { temperature: opts?.temperature ?? settings().temperature }),
    visionEnabled: () => base.visionEnabled?.() ?? false,
    test: () => base.test(),
  };
}

const field = (root: HTMLElement, k: string) => root.querySelector<HTMLInputElement>(`input[data-k="${k}"]`);

/** 对话框里现在填的值（接口地址和模型留空时用默认值，免得存成一份用不了的配置） */
function draft(root: HTMLElement): AiSettings {
  const val = (k: string) => (field(root, k)?.value || '').trim();
  const temp = Number(field(root, 'temperature')?.value);
  return {
    textBase: val('textBase') || AI_DEFAULTS.textBase,
    textKey: val('textKey'),
    textModel: val('textModel') || AI_DEFAULTS.textModel,
    visionModel: val('visionModel'),
    temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : AI_DEFAULTS.temperature,
  };
}

let current: HTMLElement | null = null;

/** 大模型设置对话框（页面右上角的按钮和宿主的 openSettings 都指到这里） */
export function openAiSettingsDialog() {
  if (current) { field(current, 'textBase')?.focus(); return; }
  const s = loadAiSettings();
  const mask = document.createElement('div');
  mask.className = 'ip-mask';
  mask.replaceChildren(html`<div class="ip-dialog" role="dialog" aria-label="${L('大模型设置', 'AI settings')}">
    <h3>${L('大模型设置', 'AI settings')}</h3>
    <label class="ip-field"><span>${L('接口地址', 'Base URL')}</span><input data-k="textBase" type="text" spellcheck="false" autocomplete="off" value="${s.textBase}" placeholder="https://api.openai.com/v1"></label>
    <label class="ip-field"><span>${L('API Key', 'API key')}</span><input data-k="textKey" type="password" spellcheck="false" autocomplete="off" value="${s.textKey}"></label>
    <label class="ip-field"><span>${L('模型', 'Model')}</span><input data-k="textModel" type="text" spellcheck="false" autocomplete="off" value="${s.textModel}" placeholder="gpt-4o-mini"></label>
    <label class="ip-field"><span>${L('识图模型', 'Vision model')}</span><input data-k="visionModel" type="text" spellcheck="false" autocomplete="off" value="${s.visionModel}" placeholder="${L('留空时用上面的模型', 'Empty uses the model above')}"></label>
    <label class="ip-field"><span>${L('温度', 'Temperature')}</span><input data-k="temperature" type="number" min="0" max="2" step="0.1" value="${s.temperature}"></label>
    <div class="ip-note">${L('只存在这台浏览器的 localStorage 里（island-palace:ai），不会写进宫殿数据；拍照识物需要能看图的模型。', 'Stored only in this browser’s localStorage (island-palace:ai), never in palace data. Photo recognition needs a model that can see images.')}</div>
    <div class="ip-actions">
      <span class="ip-status"></span>
      <button type="button" data-act="close">${L('取消', 'Cancel')}</button>
      <button type="button" data-act="test">${L('测试连接', 'Test')}</button>
      <button type="button" class="ip-primary" data-act="save">${L('保存', 'Save')}</button>
    </div>
  </div>`);

  const status = mask.querySelector('.ip-status') as HTMLElement;
  const say = (text: string, err = false) => { status.textContent = text; status.classList.toggle('ip-error', err); };
  const close = () => { if (current === mask) current = null; mask.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  mask.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el === mask) { close(); return; }
    const btn = el.closest('button');
    const act = btn?.dataset.act;
    if (act === 'close') close();
    else if (act === 'save') { saveAiSettings(draft(mask)); close(); }
    else if (act === 'test' && btn) {
      const buttons = Array.from(mask.querySelectorAll('button'));
      buttons.forEach(b => { b.disabled = true; });
      say(L('正在连接…', 'Connecting…'));
      void createAiClient(() => draft(mask)).test().then(
        (reply) => say(L(`连接成功：${reply}`, `Connected: ${reply}`)),
        (err) => say(String(err instanceof Error ? err.message : err), true),
      ).finally(() => { buttons.forEach(b => { b.disabled = false; }); });
    }
  });

  document.addEventListener('keydown', onKey);
  current = mask;
  document.body.appendChild(mask);
  field(mask, 'textBase')?.focus();
}
