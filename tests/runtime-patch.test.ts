import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PATCH_MARKER, TRAINER_PATCH_MARKER, TRAINER_VERSION_MARKER, patchRuntime, patchTrainer, patchedSource, trainerPatchedSource, trainerVersionPatchedSource } from '../src/runtime-patch.ts';

const dir = mkdtempSync(join(tmpdir(), 'sovits-patch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 按真实 `TTS.py` 的片段缩出来的最小样例：五处锚点各一处。 */
const FIXTURE = `class TTS:
    def _init_models(
        self,
    ):
        self.init_t2s_weights(self.configs.t2s_weights_path)
        self.init_vits_weights(self.configs.vits_weights_path)
        self.init_bert_weights(self.configs.bert_base_path)
        self.init_cnhuhbert_weights(self.configs.cnhuhbert_base_path)

    def init_cnhuhbert_weights(self, base_path: str):
        self.cnhuhbert_model = CNHubert(base_path)

    def _set_prompt_semantic(self, ref_wav_path: str):
        zero_wav = np.zeros(
            1,
        )
        with torch.no_grad():
            codes = self.vits_model.extract_latent(hubert_feature)
            prompt_semantic = codes[0, 0].to(self.configs.device)
            self.prompt_cache["prompt_semantic"] = prompt_semantic

    def batch_sequences(self, sequences: List[torch.Tensor], axis: int = 0):
        pass

    def run(self, text_lang: str = "zh", prompt_lang: str = "zh"):
        no_prompt_text = False
        assert text_lang in self.configs.languages
        if not no_prompt_text:
            assert prompt_lang in self.configs.languages
`;

function writeRuntime(root: string, source: string): string {
  const file = join(root, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

describe('运行时按需加载补丁', () => {
  it('五处改动都插进去，原实现保留', () => {
    const patched = patchedSource(FIXTURE)!;
    expect(patched).toContain(`self._coopanion_bert_loaded = False\n        self._coopanion_hubert_loaded = False`);
    expect(patched).not.toContain('self.init_bert_weights(self.configs.bert_base_path)\n        self.init_cnhuhbert_weights');
    expect(patched).toContain('def _coopanion_ensure_bert(self):');
    expect(patched).toContain('def _coopanion_ensure_hubert(self):');
    expect(patched).toContain('def _coopanion_release_hubert(self):');
    expect(patched).toContain('        self._coopanion_ensure_hubert()\n        zero_wav = np.zeros(');
    expect(patched).toContain('        self._coopanion_release_hubert()\n\n    def batch_sequences(');
    expect(patched).toContain('            self._coopanion_ensure_bert()\n');
    expect(patched).toContain(
      'if "zh" in f"{text_lang},{prompt_lang}" or "auto" in f"{text_lang},{prompt_lang}":',
    );
    // 原有方法一个不少。
    for (const kept of ['self.init_t2s_weights(self.configs.t2s_weights_path)', 'def _set_prompt_semantic(self, ref_wav_path: str):', 'def batch_sequences(']) {
      expect(patched).toContain(kept);
    }
  });

  it('已经打过就返回 null，不重复插入', () => {
    const patched = patchedSource(FIXTURE)!;
    expect(patched).toContain(PATCH_MARKER);
    expect(patchedSource(patched)).toBeNull();
  });

  it('任一锚点对不上就不动（运行时升级后不崩）', () => {
    expect(patchedSource(FIXTURE.replace('    def batch_sequences(', '    def batch_sequences_v2('))).toBeNull();
    expect(patchedSource(FIXTURE.replace('self.init_bert_weights(self.configs.bert_base_path)', 'self.init_bert_weights(self.configs.bert_path)'))).toBeNull();
  });

  it('CRLF 的文件保持 CRLF', () => {
    const patched = patchedSource(FIXTURE.replace(/\n/g, '\r\n'))!;
    expect(patched).toContain('_coopanion_ensure_bert');
    expect((patched.match(/\r\n/g) ?? []).length).toBe((patched.match(/\n/g) ?? []).length);
  });
});

describe('patchRuntime', () => {
  it('打一次返回 patched，再打返回 already', () => {
    const root = join(dir, 'runtime');
    const file = writeRuntime(root, FIXTURE);
    expect(patchRuntime(root)).toBe('patched');
    expect(readFileSync(file, 'utf8')).toContain(PATCH_MARKER);
    expect(patchRuntime(root)).toBe('already');
  });

  it('没有 TTS.py 返回 missing', () => {
    expect(patchRuntime(join(dir, 'nope'))).toBe('missing');
  });

  it('锚点对不上返回 unsupported，文件原样', () => {
    const root = join(dir, 'old');
    const file = writeRuntime(root, 'class TTS:\n    pass\n');
    expect(patchRuntime(root)).toBe('unsupported');
    expect(readFileSync(file, 'utf8')).toBe('class TTS:\n    pass\n');
  });
});

/** 按真实 `webui.py` 的启动块缩出来的最小样例。 */
const TRAINER_FIXTURE = `import os
import sys

os.environ["version"] = version = "v2Pro"

webui_port_main = 9873

    app.queue().launch(  # concurrency_count=511, max_size=1022
        server_name="0.0.0.0",
        inbrowser=True,
        share=is_share,
        server_port=webui_port_main,
    )
`;

describe('训练 WebUI 补丁', () => {
  it('打上补丁：只绑回环、不自动开浏览器、端口读环境变量', () => {
    const patched = trainerPatchedSource(TRAINER_FIXTURE)!;
    expect(patched).toContain(TRAINER_PATCH_MARKER);
    expect(patched).toContain('127.0.0.1');
    expect(patched).toContain('inbrowser=False');
    expect(patched).toContain('COOPANION_TRAINER_PORT');
    expect(patched).not.toContain('server_name="0.0.0.0"');
    expect(patched).not.toContain('inbrowser=True');
  });

  it('已经打过就返回 null，不重复插入', () => {
    const patched = trainerPatchedSource(TRAINER_FIXTURE)!;
    expect(trainerPatchedSource(patched)).toBeNull();
  });

  it('锚点对不上就不动（运行时升级后不崩）', () => {
    expect(trainerPatchedSource(TRAINER_FIXTURE.replace('server_name="0.0.0.0"', 'server_name=HOST'))).toBeNull();
    expect(trainerPatchedSource('def launch():\n    pass\n')).toBeNull();
  });

  it('CRLF 的文件保持 CRLF', () => {
    const patched = trainerPatchedSource(TRAINER_FIXTURE.replace(/\n/g, '\r\n'))!;
    expect(patched).toContain('127.0.0.1');
    expect((patched.match(/\r\n/g) ?? []).length).toBe((patched.match(/\n/g) ?? []).length);
  });
});

describe('训练 WebUI 默认版本补丁', () => {
  it('默认版本改成读 COOPANION_TRAINER_VERSION，留上游默认兜底', () => {
    const patched = trainerVersionPatchedSource(TRAINER_FIXTURE)!;
    expect(patched).toContain(TRAINER_VERSION_MARKER);
    expect(patched).toContain('os.environ.get("COOPANION_TRAINER_VERSION", "v2Pro")');
    expect(patched).not.toContain('os.environ["version"] = version = "v2Pro"');
  });

  it('已经打过就返回 null，不重复插入', () => {
    const patched = trainerVersionPatchedSource(TRAINER_FIXTURE)!;
    expect(trainerVersionPatchedSource(patched)).toBeNull();
  });

  it('锚点对不上就不动（运行时升级后不崩）', () => {
    expect(trainerVersionPatchedSource(TRAINER_FIXTURE.replace('"v2Pro"', '"v2ProPlus"'))).toBeNull();
  });

  it('CRLF 的文件保持 CRLF', () => {
    const patched = trainerVersionPatchedSource(TRAINER_FIXTURE.replace(/\n/g, '\r\n'))!;
    expect(patched).toContain('COOPANION_TRAINER_VERSION');
    expect((patched.match(/\r\n/g) ?? []).length).toBe((patched.match(/\n/g) ?? []).length);
  });
});

describe('patchTrainer 两处一起打', () => {
  const writeWebui = (root: string, source: string): string => {
    const file = join(root, 'webui.py');
    mkdirSync(root, { recursive: true });
    writeFileSync(file, source);
    return file;
  };

  it('启动块与默认版本都打上；第二次返回 already', () => {
    const root = join(dir, 'trainer');
    const file = writeWebui(root, TRAINER_FIXTURE);
    expect(patchTrainer(root)).toBe('patched');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(TRAINER_PATCH_MARKER);
    expect(text).toContain(TRAINER_VERSION_MARKER);
    expect(patchTrainer(root)).toBe('already');
  });

  it('旧版只打过启动块时，补上默认版本行', () => {
    const root = join(dir, 'trainer-old');
    const file = writeWebui(root, trainerPatchedSource(TRAINER_FIXTURE)!);
    expect(patchTrainer(root)).toBe('patched');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(TRAINER_PATCH_MARKER);
    expect(text).toContain(TRAINER_VERSION_MARKER);
    expect(patchTrainer(root)).toBe('already');
  });

  it('版本行锚点对不上时静默跳过，启动块照打', () => {
    const root = join(dir, 'trainer-nover');
    const file = writeWebui(root, TRAINER_FIXTURE.replace('os.environ["version"] = version = "v2Pro"', 'os.environ["version"] = version = DEFAULT'));
    expect(patchTrainer(root)).toBe('patched');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(TRAINER_PATCH_MARKER);
    expect(text).not.toContain(TRAINER_VERSION_MARKER);
  });
});
