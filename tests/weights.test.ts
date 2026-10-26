import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { infererYaml, yamlScalar } from '../src/server.ts';
import { OFFICIAL_VOICES, officialVoice, weightPaths } from '../src/catalog.ts';
import { installedBaseWeights, officialWeights, readSovitsHeader, resolveTrained, sovitsVersion, SOVITS_HEADERS } from '../src/weights.ts';

const dir = mkdtempSync(join(tmpdir(), 'sovits-weights-'));

/** 造一个 `.pth`：前两字节是版本标记，后面随便填。 */
function pth(name: string, head: string): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat([Buffer.from(head, 'ascii'), Buffer.alloc(32, 7)]));
  return file;
}

/** 造一个 `.ckpt`：真实 s1 权重一百多 MB，这里只保证过得了「不像拿错文件」的大小检查。 */
function ckpt(name: string, bytes = 2 * 1024 * 1024): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SoVITS 权重版本头', () => {
  it('读出两字节版本标记', () => {
    expect(readSovitsHeader(pth('a.pth', '08'))).toBe('08');
    expect(readSovitsHeader(pth('b.pth', '06'))).toBe('06');
  });

  it('zip 头等非数字开头返回 null，不当成 GPT-SoVITS 权重', () => {
    expect(readSovitsHeader(pth('c.pth', 'PK'))).toBeNull();
  });

  it('文件不存在时返回 null 而不是抛出', () => {
    expect(readSovitsHeader(join(dir, 'nope.pth'))).toBeNull();
  });

  it('只有 08 与 06 对应本扩展带的两套底座', () => {
    expect(sovitsVersion(pth('d.pth', '08'))).toMatchObject({ code: '08', version: 'v5turbo' });
    expect(sovitsVersion(pth('e.pth', '06'))).toMatchObject({ code: '06', version: 'v2ProPlus' });
    expect(sovitsVersion(pth('f.pth', '05'))).toMatchObject({ code: '05', lang: 'v2Pro', version: null });
    expect(sovitsVersion(pth('g.pth', '99'))).toMatchObject({ code: '99', version: null });
    expect(Object.keys(SOVITS_HEADERS)).toContain('07');
  });
});

describe('自备权重校验', () => {
  const gpt = ckpt('m-e12.ckpt');
  const v5 = pth('m_e8_l32.pth', '08');
  const v2 = pth('m_e8_v2.pth', '06');

  it('两个都空表示用内置权重，不算问题', () => {
    expect(resolveTrained({ gpt: '', sovits: '' }, 'v5turbo')).toEqual({ weights: null, problem: null });
    expect(resolveTrained(undefined, 'v5turbo')).toEqual({ weights: null, problem: null });
  });

  it('只填一半要报出来，不能悄悄只换一个', () => {
    expect(resolveTrained({ gpt, sovits: '' }, 'v5turbo').problem).toContain('只填了 GPT');
    expect(resolveTrained({ gpt: '', sovits: v5 }, 'v5turbo').problem).toContain('只填了 SoVITS');
  });

  it('扩展名不对要拦下', () => {
    expect(resolveTrained({ gpt: v5, sovits: v5 }, 'v5turbo').problem).toContain('.ckpt');
    expect(resolveTrained({ gpt, sovits: gpt }, 'v5turbo').problem).toContain('.pth');
  });

  it('路径不存在要给出来', () => {
    expect(resolveTrained({ gpt: join(dir, 'x.ckpt'), sovits: v5 }, 'v5turbo').problem).toContain('找不到');
    expect(resolveTrained({ gpt, sovits: join(dir, 'x.pth') }, 'v5turbo').problem).toContain('找不到');
  });

  it('几十 KB 的 .ckpt 当成拿错文件，不等到加载才崩', () => {
    const tiny = ckpt('note.ckpt', 4096);
    expect(resolveTrained({ gpt: tiny, sovits: v5 }, 'v5turbo').problem).toContain('不像训练出来的');
  });

  it('版本和推理档不一致要拦下，而不是等底座缺失再崩', () => {
    const p = resolveTrained({ gpt, sovits: v5 }, 'v2ProPlus');
    expect(p.weights).toBeNull();
    expect(p.problem).toContain('v5turbo');
    expect(p.problem).toContain('v2ProPlus');
  });

  it('读不出头的文件要说清看见了什么：官方底模以 PK 开头', () => {
    const p = resolveTrained({ gpt, sovits: pth('base.pth', 'PK') }, 'v5turbo');
    expect(p.weights).toBeNull();
    expect(p.problem).toContain('模型存档');
  });

  it('运行时没有的底座(v2Pro 等)直接说明只支持两种', () => {
    const pro = pth('m_v2pro.pth', '05');
    expect(resolveTrained({ gpt, sovits: pro }, 'v5turbo').problem).toContain('只支持 v5turbo');
  });

  it('都对上就返回两条路径', () => {
    expect(resolveTrained({ gpt, sovits: v5 }, 'v5turbo')).toEqual({ weights: { gpt, sovits: v5 }, problem: null });
    expect(resolveTrained({ gpt, sovits: v2 }, 'v2ProPlus')).toEqual({ weights: { gpt, sovits: v2 }, problem: null });
  });
});

describe('api_v2 配置里的路径', () => {
  it('内置权重保持相对路径，不加引号', () => {
    const y = infererYaml('cuda', 'v5turbo');
    expect(y).toContain('t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt');
    expect(y).toContain('vits_weights_path: GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth');
  });

  it('自备权重写成带引号的绝对路径，反斜杠原样保留', () => {
    const y = infererYaml('cuda', 'v5turbo', { gpt: 'D:\\w\\大肥鱼-e12.ckpt', sovits: 'D:\\w\\大肥鱼_e8_l32.pth' });
    expect(y).toContain("t2s_weights_path: 'D:\\w\\大肥鱼-e12.ckpt'");
    expect(y).toContain("vits_weights_path: 'D:\\w\\大肥鱼_e8_l32.pth'");
    expect(y).toContain('version: v5turbo');
  });

  it('含空格或引号的标量才加引号', () => {
    expect(yamlScalar('plain/path.pth')).toBe('plain/path.pth');
    expect(yamlScalar('C:\\a b\\x.pth')).toBe("'C:\\a b\\x.pth'");
    expect(yamlScalar("it's.pth")).toBe("'it''s.pth'");
  });

  it('内置底模的绝对路径：托管安装的权重目录就是 pretrained_models 本身', () => {
    const base = installedBaseWeights('D:\\models\\gpt-sovits\\pretrained_models', 'v5turbo');
    expect(base.gpt).toBe(join('D:\\models\\gpt-sovits\\pretrained_models', 's1v3.ckpt'));
    expect(base.sovits).toBe(join('D:\\models\\gpt-sovits\\pretrained_models', 'gsv-v5-pretrained', 's2Gv5turbo.pth'));
    expect(installedBaseWeights('C:\\w', 'v2ProPlus').sovits).toBe(join('C:\\w', 'v2Pro', 's2Gv2ProPlus.pth'));
  });

  it('托管目录与运行时根是两套路径，别把 GPT_SoVITS/pretrained_models 拼两遍', () => {
    const modelsDir = join('D:\\m', 'pretrained_models');
    expect(installedBaseWeights(modelsDir, 'v5turbo').gpt).not.toContain('GPT_SoVITS');
    expect(weightPaths('v5turbo').t2s).toBe('GPT_SoVITS/pretrained_models/s1v3.ckpt');
    expect(weightPaths('v5turbo').vits).toBe('GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2Gv5turbo.pth');
    expect(weightPaths('v2ProPlus').vits).toBe('GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth');
  });
});

describe('随包官模', () => {
  it('按预设挑：xll 与 dfy 有，female/male 与自定义音色没有', () => {
    expect(officialVoice('xll')?.gpt).toBe('xll/feiyu_xll_e30.ckpt');
    expect(officialVoice('dfy')?.sovits).toBe('dfy/dfy_5_e12_s1380_l32.pth');
    expect(officialVoice('female')).toBeNull();
    expect(officialVoice('male')).toBeNull();
    expect(officialVoice('自定义 id')).toBeNull();
  });

  it('每个官模都列出两个文件的下载清单，且 path 与 gpt/sovits 对得上', () => {
    for (const voice of Object.values(OFFICIAL_VOICES)) {
      expect(voice.files.map((f) => f.path)).toEqual([voice.gpt, voice.sovits]);
      for (const f of voice.files) {
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.sources.length).toBeGreaterThan(0);
      }
    }
  });

  it('权重没下齐时返回 null，下齐才给绝对路径', () => {
    const modelsDir = join(dir, 'models');
    for (const voice of Object.values(OFFICIAL_VOICES)) {
      expect(officialWeights(modelsDir, voice.sovits.startsWith('xll/') ? 'xll' : 'dfy')).toBeNull();
      for (const f of voice.files) {
        const file = join(modelsDir, f.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(8, 1));
      }
      const got = officialWeights(modelsDir, voice.sovits.startsWith('xll/') ? 'xll' : 'dfy');
      expect(got).toEqual({ gpt: join(modelsDir, voice.gpt), sovits: join(modelsDir, voice.sovits) });
    }
  });
});
