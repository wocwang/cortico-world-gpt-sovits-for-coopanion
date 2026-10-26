/**
 * 托管运行时的按需加载补丁：上游 `TTS.py` 在 `_init_models` 里无条件把 BERT(约 622 MB 显存)与
 * CNHuBERT(约 188 MB)读进设备，但 BERT 只有中文会用到(日/英直接送零特征)，CNHuBERT 只在换参考
 * 音频时用一次。这里对这两个模型做纯文本补丁，改成按需加载/用完即卸。
 *
 * 只动托管运行时（自备目录是用户的，不该改）；锚点对不上（运行时升级换了写法）就原样放弃，不影响启动。
 * 补丁只插代码、不改原有实现，重复执行无副作用。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 打在 `TTS.py` 里的标记；有它就认为已经打过补丁。 */
export const PATCH_MARKER = '_coopanion_ensure_bert';

export type PatchResult = 'patched' | 'already' | 'unsupported' | 'missing';

/** 相对运行时根的位置。 */
const PATCH_FILE = join('GPT_SoVITS', 'TTS_infer_pack', 'TTS.py');

/**
 * 五处改动，锚点必须全部命中才写文件：
 * 1. `_init_models` 不再启动即加载，只放两个「已加载」标记；
 * 2. 在 `init_cnhuhbert_weights` 前插入三个按需加载/释放的方法；
 * 3. `_set_prompt_semantic` 开头确保 CNHuBERT 就位；
 * 4. `_set_prompt_semantic` 算完 prompt_semantic 立刻释放 CNHuBERT；
 * 5. `run` 里只有中文（或 auto 逐段判断）才确保 BERT 就位。
 */
const EDITS: ReadonlyArray<{ find: string; replace: string }> = [
  {
    find: [
      '        self.init_bert_weights(self.configs.bert_base_path)',
      '        self.init_cnhuhbert_weights(self.configs.cnhuhbert_base_path)',
    ].join('\n'),
    replace: [
      '        # [coopanion-patch] BERT 只有中文会用到(日/英送零特征), CNHuBERT 只在换参考音频时用一次: 都改成按需加载',
      '        self._coopanion_bert_loaded = False',
      '        self._coopanion_hubert_loaded = False',
    ].join('\n'),
  },
  {
    find: '    def init_cnhuhbert_weights(self, base_path: str):',
    replace: [
      '    # [coopanion-patch] 按需加载/释放; 不改变模型本身的实现',
      '    def _coopanion_ensure_bert(self):',
      '        if self._coopanion_bert_loaded:',
      '            return',
      '        self.init_bert_weights(self.configs.bert_base_path)',
      '        self.text_preprocessor.bert_model = self.bert_model',
      '        self.text_preprocessor.tokenizer = self.bert_tokenizer',
      '        self.text_preprocessor.device = self.configs.device',
      '        self._coopanion_bert_loaded = True',
      '',
      '    def _coopanion_ensure_hubert(self):',
      '        if self._coopanion_hubert_loaded:',
      '            return',
      '        self.init_cnhuhbert_weights(self.configs.cnhuhbert_base_path)',
      '        self._coopanion_hubert_loaded = True',
      '',
      '    def _coopanion_release_hubert(self):',
      '        if not self._coopanion_hubert_loaded:',
      '            return',
      '        self.cnhuhbert_model = None',
      '        self._coopanion_hubert_loaded = False',
      '        self.empty_cache()',
      '',
      '    def init_cnhuhbert_weights(self, base_path: str):',
    ].join('\n'),
  },
  {
    find: [
      '    def _set_prompt_semantic(self, ref_wav_path: str):',
      '        zero_wav = np.zeros(',
    ].join('\n'),
    replace: [
      '    def _set_prompt_semantic(self, ref_wav_path: str):',
      '        # [coopanion-patch] 换参考音频才需要 CNHuBERT',
      '        self._coopanion_ensure_hubert()',
      '        zero_wav = np.zeros(',
    ].join('\n'),
  },
  {
    find: [
      '            prompt_semantic = codes[0, 0].to(self.configs.device)',
      '            self.prompt_cache["prompt_semantic"] = prompt_semantic',
      '',
      '    def batch_sequences(',
    ].join('\n'),
    replace: [
      '            prompt_semantic = codes[0, 0].to(self.configs.device)',
      '            self.prompt_cache["prompt_semantic"] = prompt_semantic',
      '        # [coopanion-patch] 算完就放掉, 换下一段参考时再加载',
      '        self._coopanion_release_hubert()',
      '',
      '    def batch_sequences(',
    ].join('\n'),
  },
  {
    find: [
      '        assert text_lang in self.configs.languages',
      '        if not no_prompt_text:',
      '            assert prompt_lang in self.configs.languages',
    ].join('\n'),
    replace: [
      '        assert text_lang in self.configs.languages',
      '        if not no_prompt_text:',
      '            assert prompt_lang in self.configs.languages',
      '',
      '        # [coopanion-patch] 只有中文(或 auto 逐段判断)才需要 BERT; 日/英的 BERT 特征是零',
      '        if "zh" in f"{text_lang},{prompt_lang}" or "auto" in f"{text_lang},{prompt_lang}":',
      '            self._coopanion_ensure_bert()',
    ].join('\n'),
  },
];

export function isPatched(source: string): boolean {
  return source.includes(PATCH_MARKER);
}

/**
 * 纯函数：返回打过补丁的源码。已经有标记、或任一锚点对不上时返回 `null`（不改）。
 * 原文件是 CRLF 时保持 CRLF。
 */
export function patchedSource(source: string): string | null {
  if (isPatched(source)) return null;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replace(/\r\n/g, '\n');
  if (!EDITS.every((e) => text.includes(e.find))) return null;
  const patched = EDITS.reduce((s, e) => s.replace(e.find, e.replace), text);
  return eol === '\n' ? patched : patched.replace(/\n/g, eol);
}

/** 给托管运行时打补丁；找不到文件或锚点不匹配时原样返回，不会让启动失败。 */
export function patchRuntime(runtimeDir: string): PatchResult {
  const file = join(runtimeDir, PATCH_FILE);
  if (!existsSync(file)) return 'missing';
  const source = readFileSync(file, 'utf8');
  if (isPatched(source)) return 'already';
  const patched = patchedSource(source);
  if (!patched) return 'unsupported';
  try {
    writeFileSync(file, patched);
  } catch {
    return 'unsupported';
  }
  return 'patched';
}
