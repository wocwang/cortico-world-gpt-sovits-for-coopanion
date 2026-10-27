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

/** 打在 `webui.py` 里的标记；有它就认为已经打过补丁。 */
export const TRAINER_PATCH_MARKER = '_coopanion_trainer_patch';

/**
 * 训练 WebUI 的启动块：上游写死 `0.0.0.0` 且自动开浏览器，这里改成只绑回环、不自动开、
 * 端口读 `COOPANION_TRAINER_PORT`。`webui.py` 顶部已经 `import os`，不再另插 import。
 */
const TRAINER_EDIT: { find: string; replace: string } = {
  find: [
    '    app.queue().launch(  # concurrency_count=511, max_size=1022',
    '        server_name="0.0.0.0",',
    '        inbrowser=True,',
    '        share=is_share,',
    '        server_port=webui_port_main,',
  ].join('\n'),
  replace: [
    '    app.queue().launch(  # concurrency_count=511, max_size=1022  # [coopanion-trainer] _coopanion_trainer_patch',
    '        server_name="127.0.0.1",  # [coopanion-trainer] 只绑回环',
    '        inbrowser=False,',
    '        share=is_share,',
    '        server_port=int(os.environ.get("COOPANION_TRAINER_PORT", webui_port_main)),',
  ].join('\n'),
};

/**
 * 纯函数：返回打过补丁的训练 WebUI 源码。已经有标记、或锚点对不上时返回 `null`（不改）。
 * 原文件是 CRLF 时保持 CRLF。
 */
export function trainerPatchedSource(source: string): string | null {
  if (source.includes(TRAINER_PATCH_MARKER)) return null;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replace(/\r\n/g, '\n');
  if (!text.includes(TRAINER_EDIT.find)) return null;
  const patched = text.replace(TRAINER_EDIT.find, TRAINER_EDIT.replace);
  return eol === '\n' ? patched : patched.replace(/\n/g, eol);
}

/** 打在 `webui.py` 默认模型版本行上的标记；有它就认为已经打过这处。 */
export const TRAINER_VERSION_MARKER = '_coopanion_trainer_version';

/**
 * 默认模型版本：上游写死 `v2Pro`，但本扩展的运行时只带 v5turbo(显卡档)/v2ProPlus(CPU 档) 的底座，
 * 训练页默认版本跟着推理档走才对得上（v2Pro 训出来的权重本插件也认不了）。
 * 改成读 `COOPANION_TRAINER_VERSION`（trainer.ts 启动时按档位注入）；没注入时维持上游默认。
 * 可选补丁：锚点对不上就跳过，不停机。
 */
const TRAINER_VERSION_EDIT: { find: string; replace: string } = {
  find: 'os.environ["version"] = version = "v2Pro"',
  replace:
    'os.environ["version"] = version = os.environ.get("COOPANION_TRAINER_VERSION", "v2Pro")  # [coopanion-trainer] _coopanion_trainer_version',
};

/**
 * 纯函数：返回改过默认版本的源码。已经有标记、或锚点对不上时返回 `null`（不改）。
 * 原文件是 CRLF 时保持 CRLF。
 */
export function trainerVersionPatchedSource(source: string): string | null {
  if (source.includes(TRAINER_VERSION_MARKER)) return null;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replace(/\r\n/g, '\n');
  if (!text.includes(TRAINER_VERSION_EDIT.find)) return null;
  const patched = text.replace(TRAINER_VERSION_EDIT.find, TRAINER_VERSION_EDIT.replace);
  return eol === '\n' ? patched : patched.replace(/\n/g, eol);
}

/**
 * 给托管运行时的 `webui.py` 打训练补丁；找不到文件或启动块锚点不匹配时原样返回，不会让启动失败。
 * 两处独立进行：启动块（端口/回环）打不上按 `unsupported`；默认版本打不上只是静默跳过。
 */
export function patchTrainer(runtimeDir: string): PatchResult {
  const file = join(runtimeDir, 'webui.py');
  if (!existsSync(file)) return 'missing';
  const source = readFileSync(file, 'utf8');
  let text = source;
  let changed = false;
  if (!text.includes(TRAINER_PATCH_MARKER)) {
    const patched = trainerPatchedSource(text);
    if (!patched) return 'unsupported';
    text = patched;
    changed = true;
  }
  if (!text.includes(TRAINER_VERSION_MARKER)) {
    const patched = trainerVersionPatchedSource(text);
    if (patched) {
      text = patched;
      changed = true;
    }
  }
  if (!changed) return 'already';
  try {
    writeFileSync(file, text);
  } catch {
    return 'unsupported';
  }
  return 'patched';
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
