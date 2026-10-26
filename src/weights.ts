/**
 * 自备训练权重的识别与校验。
 *
 * GPT-SoVITS 的两个权重分工不同：GPT(`.ckpt`, s1/T2S) 学「文本 → 语义 token」，SoVITS(`.pth`, s2)
 * 学音色与声学细节。自己训出来的通常是 s1 某个 epoch 的 `.ckpt` 加 s2 的 LoRA `.pth`。
 *
 * `.pth` 头两个字节是版本标记(LoRA 文件形如 `08`)，据此判断它配不配当前推理档——本扩展的运行时只带
 * v5turbo(显卡档)与 v2ProPlus(CPU 档)两套底座，版本对不上时底座缺失，加载必然失败，
 * 因此在写进配置之前就拦下来，给出可读的原因。
 *
 * 版本对得上也不代表底座不用下载：v5turbo 的 s2 训练产物是 LoRA 增量，加载时仍要先读
 * `s2Gv5turbo.pth` 再合并，所以自备权重不影响内置权重的安装。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { weightFiles, officialVoice, type ModelVersion } from './catalog.ts';

export interface TrainedWeights {
  /** GPT(T2S)权重，`.ckpt`。 */
  gpt: string;
  /** SoVITS(s2)权重，`.pth`。 */
  sovits: string;
}

/** `.pth` 头两字节 -> 版本。`version` 为 null 表示本扩展的运行时里没有这套底座。 */
export const SOVITS_HEADERS: Readonly<Record<string, { lang: string; version: ModelVersion | null }>> = {
  '00': { lang: 'v1', version: null },
  '01': { lang: 'v2', version: null },
  '02': { lang: 'v3', version: null },
  '03': { lang: 'v3 LoRA', version: null },
  '04': { lang: 'v4 LoRA', version: null },
  '05': { lang: 'v2Pro', version: null },
  '06': { lang: 'v2ProPlus', version: 'v2ProPlus' },
  '07': { lang: 'v5 LoRA', version: null },
  '08': { lang: 'v5turbo LoRA', version: 'v5turbo' },
};

/** 读 `.pth` 头两字节；不是 torch 存档(头不是 ASCII 数字)时返回 null。 */
export function readSovitsHeader(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(2);
    if (readSync(fd, buf, 0, 2, 0) < 2) return null;
    const code = buf.toString('ascii');
    return /^[0-9]{2}$/.test(code) ? code : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** SoVITS 权重的版本；读不出来返回 null。 */
export function sovitsVersion(file: string): { code: string; lang: string; version: ModelVersion | null } | null {
  const code = readSovitsHeader(file);
  if (!code) return null;
  const hit = SOVITS_HEADERS[code];
  return hit ? { code, ...hit } : { code, lang: `未知(${code})`, version: null };
}

/** `.ckpt` 小到这个程度基本是拿错了文件(s1 权重一百多 MB)。 */
const GPT_MIN_BYTES = 1024 * 1024;

/** 给「读不出头」的报错补一句看见的字节：以 PK 开头的是完整模型存档(如官方底模)，不是训练产物。 */
function headHint(file: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(2);
    if (readSync(fd, buf, 0, 2, 0) < 2) return '文件太短';
    const head = buf.toString('latin1');
    if (head === 'PK') return '以 PK 开头，是完整的模型存档，不是训练导出的 LoRA 或 s2 权重';
    return `开头是 ${JSON.stringify(head)}`;
  } catch {
    return '读不开这个文件';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface TrainedResult {
  /** 可用的权重；用不上时为 null。 */
  weights: TrainedWeights | null;
  /** 填了但用不上的原因，直给用户看。 */
  problem: string | null;
  /** 这组权重来自随包官模（而不是自备文件）。 */
  official?: boolean;
}

/**
 * 校验配置里的自备权重。两个都留空才算「用内置权重」；只填一个是常见的手误，直接当问题报出来，
 * 而不是悄悄只换一半——只换 s1 不换 s2 出来的音色是不对的。
 */
export function resolveTrained(setting: Partial<TrainedWeights> | undefined, expected: ModelVersion): TrainedResult {
  const gpt = (setting?.gpt ?? '').trim();
  const sovits = (setting?.sovits ?? '').trim();
  if (!gpt && !sovits) return { weights: null, problem: null };
  if (!gpt) return { weights: null, problem: '自备权重只填了 SoVITS(.pth)，GPT(.ckpt)还空着；两个要一起填。' };
  if (!sovits) return { weights: null, problem: '自备权重只填了 GPT(.ckpt)，SoVITS(.pth)还空着；两个要一起填。' };
  if (extname(gpt).toLowerCase() !== '.ckpt') return { weights: null, problem: `GPT 权重要是 .ckpt，现在是 ${extname(gpt) || '没有扩展名'}。` };
  if (extname(sovits).toLowerCase() !== '.pth') return { weights: null, problem: `SoVITS 权重要是 .pth，现在是 ${extname(sovits) || '没有扩展名'}。` };
  if (!existsSync(gpt)) return { weights: null, problem: `找不到 GPT 权重：${gpt}` };
  if (!existsSync(sovits)) return { weights: null, problem: `找不到 SoVITS 权重：${sovits}` };
  if (statSync(gpt).size < GPT_MIN_BYTES) return { weights: null, problem: `GPT 权重只有 ${Math.round(statSync(gpt).size / 1024)} KB，不像训练出来的 s1 权重：${gpt}` };

  const v = sovitsVersion(sovits);
  if (!v) return { weights: null, problem: `读不出 SoVITS 权重的版本头(${headHint(sovits)})，训练出来的 .pth 开头应有两位版本号：${sovits}` };
  if (!v.version) return { weights: null, problem: `这套运行时没有 ${v.lang} 的底座，只支持 v5turbo(08) 与 v2ProPlus(06)。` };
  if (v.version !== expected) {
    return { weights: null, problem: `权重是 ${v.lang}，当前推理档用的是 ${expected}；换推理档或换成对应版本的权重。` };
  }
  return { weights: { gpt, sovits }, problem: null };
}

/**
 * 托管安装时内置底模的绝对路径：权重目录本身就是运行时的 `pretrained_models`,
 * 所以底模文件直接在它下面(`s1v3.ckpt`、`gsv-v5-pretrained/s2Gv5turbo.pth`)。
 * 自备目录的后端不走这里——那种目录按运行时根下的 `GPT_SoVITS/pretrained_models/...` 拼。
 */
export function installedBaseWeights(modelsDir: string, version: ModelVersion): TrainedWeights {
  const f = weightFiles(version);
  return { gpt: join(modelsDir, f.t2s), sovits: join(modelsDir, f.vits) };
}

/**
 * 随包官模的权重（在托管权重目录下），装好才返回绝对路径。
 * 都是 v5turbo 的 LoRA 增量，只在显卡档可用；CPU 档退回底模 + 同一套参考音频。
 */
export function officialWeights(modelsDir: string, preset: string): TrainedWeights | null {
  const voice = officialVoice(preset);
  if (!voice) return null;
  const gpt = join(modelsDir, voice.gpt);
  const sovits = join(modelsDir, voice.sovits);
  if (!existsSync(gpt) || !existsSync(sovits)) return null;
  return { gpt, sovits };
}
