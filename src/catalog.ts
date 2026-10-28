/**
 * 钉住的运行时包与权重：每个文件写明字节数、SHA-256 与按顺序尝试的来源。
 *
 * 运行时包是本仓 `scripts/build-runtime.sh` 打出来的 zip:上游 GPT-SoVITS 在 UPSTREAM_COMMIT 的推理代码、
 * `runtime/` 里的独立 CPython 3.12 与依赖(显卡档带 CUDA 版 torch 与 FlashAttention)、G2PW 与 NLTK、
 * Open JTalk 词典;不含 `GPT_SoVITS/pretrained_models/`,那里在启动前接到权重目录。
 */
import type { Tier } from './config.ts';

export const UPSTREAM_REPO = 'RVC-Boss/GPT-SoVITS';
export const UPSTREAM_COMMIT = 'e91506f1fba265e1841617c3042a1573206a7351';

/** 运行时版本：上游 commit 短号加本仓的打包序号。 */
export const RUNTIME_VERSION = 'e91506f-1';

export interface PinnedFile {
  /** 落盘的相对路径。 */
  path: string;
  bytes: number;
  sha256: string;
  /** 下载地址，按顺序尝试。 */
  sources: readonly string[];
}

/** 一档运行时：一个 zip,可分片(GitHub Release 单个附件不能超过 2 GiB),按顺序拼回后校验整体。 */
export interface RuntimeAsset {
  file: string;
  bytes: number;
  sha256: string;
  /** 整包的下载地址，按顺序尝试。 */
  sources: readonly string[];
  /** 分片的下载地址;整包地址都失败后才用。 */
  parts?: ReadonlyArray<{ bytes: number; sources: readonly string[] }>;
}

const MS_OWN = 'https://www.modelscope.cn/models/Phantivia/gpt-sovits-for-coopanion/resolve/master';
const GH_OWN = `https://github.com/Phantivia/cortico-world-gpt-sovits-for-coopanion/releases/download/runtime-${RUNTIME_VERSION}`;

const CUDA_FILE = `gpt-sovits-${RUNTIME_VERSION}-win-x64-cu128.zip`;
const CPU_FILE = `gpt-sovits-${RUNTIME_VERSION}-win-x64-cpu.zip`;

/** 魔搭放整包;GitHub Release 放不下 2 GiB 以上的整包，显卡档在那里只有分片。 */
export const RUNTIME_ASSETS: Readonly<Record<Tier, RuntimeAsset>> = {
  cuda: {
    file: CUDA_FILE,
    bytes: 4140732064,
    sha256: '87c775a93f9b13195b83bc2901a6176f771e31076bc051acf07a5ccca1db7a78',
    sources: [`${MS_OWN}/runtime/${CUDA_FILE}`],
    parts: [
      { bytes: 1992294400, sources: [`${GH_OWN}/${CUDA_FILE}.part0`] },
      { bytes: 1992294400, sources: [`${GH_OWN}/${CUDA_FILE}.part1`] },
      { bytes: 156143264, sources: [`${GH_OWN}/${CUDA_FILE}.part2`] },
    ],
  },
  cpu: {
    file: CPU_FILE,
    bytes: 1036310624,
    sha256: '9ce348074e941388544b4db072ee0b9cfc50c9bd420e61f13ee9364fe90152e1',
    sources: [`${MS_OWN}/runtime/${CPU_FILE}`, `${GH_OWN}/${CPU_FILE}`],
  },
};

/** 每档用的模型版本，即 api_v2 配置里的 `version`。 */
export const TIER_MODEL: Readonly<Record<Tier, ModelVersion>> = {
  cuda: 'v5turbo',
  cpu: 'v2ProPlus',
};

export type ModelVersion = 'v5turbo' | 'v2ProPlus';

/**
 * 播放时乘的增益。实测 v2ProPlus 经 api_v2 出来的峰值约 −7~−8 dBFS，乘 2 倍（+6 dB）
 * 仍留约 1 dB 余量；以前按「−27 dBFS」乘 8 倍，会把两成以上样本压进软限幅，听起来发糊。
 * V5 接近满幅，乘 1。
 */
export const OUTPUT_GAIN: Readonly<Record<ModelVersion, number>> = {
  v5turbo: 1,
  v2ProPlus: 2,
};

const MS_UP = 'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models';
const HF_MIRROR_UP = 'https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main';
const HF_UP = 'https://huggingface.co/lj1995/GPT-SoVITS/resolve/main';

/** 上游两个仓库里同一路径的文件：魔搭优先，其次 hf-mirror，最后官方 HF（国内多半不通，只当兜底）。 */
const upstream = (path: string, bytes: number, sha256: string): PinnedFile => ({
  path, bytes, sha256, sources: [`${MS_UP}/${path}`, `${HF_MIRROR_UP}/${path}`, `${HF_UP}/${path}`],
});

/** 两个版本共用的文本与参考音频特征模型。 */
const SHARED: readonly PinnedFile[] = [
  upstream('s1v3.ckpt', 155284856, '87133414860ea14ff6620c483a3db5ed07b44be42e2c3fcdad65523a729a745a'),
  upstream('chinese-hubert-base/config.json', 1449, 'c3e5060a1277e0f078cc6be9da4528a605dba6ece93018981fe2c820e5c7b103'),
  upstream('chinese-hubert-base/preprocessor_config.json', 212, 'dcd684124d06722947939d41ea6ae58dbf10968c60a11a29f23ddc602c64a29b'),
  upstream('chinese-hubert-base/pytorch_model.bin', 188811417, '24164f129c66499d1346e2aa55f183250c223161ec2770c0da3d3b08cf432d3c'),
  upstream('chinese-roberta-wwm-ext-large/config.json', 963, '3d57de2fd7e80d0e5c8ff194f0bbb6baa10df7e43fc262a0cc71298a78b0a3e5'),
  upstream('chinese-roberta-wwm-ext-large/pytorch_model.bin', 651225145, 'e53a693acc59ace251d143d068096ae0d7b79e4b1b503fa84c9dcf576448c1d8'),
  upstream('chinese-roberta-wwm-ext-large/tokenizer.json', 268962, '173796956820ea27bd14f76bf28162607ff4254807e2948253eb5b46f5bb643b'),
  upstream('fast_langdetect/lid.176.bin', 131266198, '7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e'),
];

/** 上游魔搭仓库还没有 V5 权重：先试本扩展的魔搭仓库，再 hf-mirror，最后上游 Hugging Face。 */
const v5 = (path: string, bytes: number, sha256: string): PinnedFile => ({
  path, bytes, sha256, sources: [`${MS_OWN}/pretrained_models/${path}`, `${HF_MIRROR_UP}/${path}`, `${HF_UP}/${path}`],
});

/** 随包官模的权重与下载清单。都是 v5turbo 的 LoRA 增量，CPU 档用不了，退回底模。 */
export interface OfficialVoice {
  /** 托管权重目录下的相对路径。 */
  gpt: string;
  sovits: string;
  /** 选中这个预设时才下载的文件。 */
  files: readonly PinnedFile[];
}

/**
 * 官模按预设挑。当前为空：`xll` 改为底模 + 参考音频的零样本音色，
 * 不再随包/下载训练权重（训练版的高频质感不如底模）。
 */
export const OFFICIAL_VOICES: Readonly<Record<string, OfficialVoice>> = {};

/** 选中的预设对应的官模；`female` / `male` / 自定义音色返回 null。 */
export const officialVoice = (preset: string): OfficialVoice | null => OFFICIAL_VOICES[preset] ?? null;

/** 训练用的预训练资源：v5turbo 训练所需文件随推理权重已就位，只差 v2ProPlus 的判别器 s2D。 */
export const TRAIN_ASSETS: readonly PinnedFile[] = [
  upstream('v2Pro/s2Dv2ProPlus.pth', 126432639, '635cd84bf6f7f9b8d41c88c7106f81d782c794c61f931845214ea037b0c5bef2'),
];

export const MODEL_FILES: Readonly<Record<ModelVersion, readonly PinnedFile[]>> = {
  v5turbo: [...SHARED, v5('gsv-v5-pretrained/s2Gv5turbo.pth', 766406144, '287b32a06b7d486f5303ec520468b0728fb01aac8b0f5d86fd5455c9a1d3e022'), v5('gsv-v5-pretrained/vocoder.pth', 57761163, 'b7543c83222aa2105bb4efb56845086bc5f2eeba61243d723ffa062052b3221f')],
  v2ProPlus: [...SHARED, upstream('v2Pro/s2Gv2ProPlus.pth', 200125741, 'd42a22bbbf65fb2bbdd45ad6a66841156977db45c7aabe0a6992ff378d9c7d3b'), upstream('sv/pretrained_eres2netv2w24s4ep4.ckpt', 107528697, '4f5a0bf73c61eb41b174e1bb54e7ee3c83233892be8e0af1f187024e8e581a35')],
};

/**
 * 权重在 `pretrained_models` 目录里的相对路径。
 * 托管安装把运行时的 `GPT_SoVITS/pretrained_models` 接成指向权重目录的目录联接，所以这里是自带的底模文件名。
 */
export function weightFiles(version: ModelVersion): { t2s: string; vits: string } {
  return {
    t2s: 's1v3.ckpt',
    vits: version === 'v5turbo' ? 'gsv-v5-pretrained/s2Gv5turbo.pth' : 'v2Pro/s2Gv2ProPlus.pth',
  };
}

/** api_v2 配置里的权重路径(相对运行时根)。 */
export function weightPaths(version: ModelVersion): { t2s: string; vits: string } {
  const f = weightFiles(version);
  return {
    t2s: `GPT_SoVITS/pretrained_models/${f.t2s}`,
    vits: `GPT_SoVITS/pretrained_models/${f.vits}`,
  };
}
