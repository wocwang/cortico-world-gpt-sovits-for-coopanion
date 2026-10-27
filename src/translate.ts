/**
 * 语音翻译：`textLang` 选 en/ja/ko 时，合成前把文字整段翻译成目标语言——送进 GPT-SoVITS 后，
 * 切句由服务端的 `cut5` 在译文上做（先翻译、再切短句）。
 *
 * 走 OpenAI 兼容的 `POST {endpoint}/chat/completions`。除「未配置」由调用方判断外，
 * 任何失败都返回 `null`，调用方回退按原文合成（与没有翻译时的旧行为一致）。
 */
import type { Logger } from 'cortico/core/types.ts';

/** 翻译目标的语言代码（与 SpeechLang 的可翻译子集一致）。 */
export type TranslateLang = 'en' | 'ja' | 'ko';

const TARGET_NAME: Record<TranslateLang, string> = { en: 'English', ja: '日本語', ko: '한국어' };

export interface TranslateConfig {
  /** OpenAI 兼容接口基址，如 `https://api.deepseek.com/v1`。 */
  endpoint: string;
  /** 密钥明文（由调用方经框架的部署级 secret 读取后传入）；空串表示不带鉴权头。 */
  apiKey: string;
  /** 模型名，如 `deepseek-chat`。 */
  model: string;
}

/** 等翻译结果的上限；超时按失败处理。 */
const TRANSLATE_TIMEOUT_MS = 20_000;

/** 把 `text` 翻译成 `target` 语言，只回译文本身；失败返回 `null`。 */
export async function translateTo(text: string, target: TranslateLang, cfg: TranslateConfig, log: Logger): Promise<string | null> {
  const url = `${cfg.endpoint.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `你是语音合成前的翻译引擎。把用户输入翻译成${TARGET_NAME[target]}：只输出译文本身，不要解释、引号或注音；口语自然，适合朗读。`,
          },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('GPT-SoVITS 翻译模型返回错误，按原文合成', { status: res.status, url });
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const out = String(data?.choices?.[0]?.message?.content ?? '').trim();
    return out || null;
  } catch (err) {
    log.warn('GPT-SoVITS 翻译失败，按原文合成', { err: String(err), url });
    return null;
  }
}