"""Coopanion GPT-SoVITS ROCm 档的运行时垫片：只补 torchaudio 的解码后端。

ROCm 版 torchaudio 从 2.9 起把 `torchaudio.load` 改成只走 TorchCodec，而运行时里没有它，
GPT-SoVITS 读参考音频与提示音频都会失败（`TorchCodec is required for load_with_torchcodec`）。
这里用运行时自带的 soundfile 兜底，输出保持 channels × samples，`always_2d` 避免单声道退化成 1-D。

MIOpen 与可见设备不在这里设：插件拉起子进程时用环境变量传（`MIOPEN_FIND_MODE` 等由原生库读，
`HIP_VISIBLE_DEVICES` 由设备探针按架构算出来），site 阶段也改不动已经初始化的 torch。

这个文件在构建期被复制成 `runtime/Lib/site-packages/sitecustomize.py`，属于运行时包内容。
"""

try:
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    def _load(uri, frame_offset=0, num_frames=-1, normalize=True,
              channels_first=True, format=None, buffer_size=4096, backend=None):
        data, sample_rate = sf.read(str(uri), dtype="float32", always_2d=True)
        wav = torch.from_numpy(np.ascontiguousarray(data.T))
        if frame_offset:
            wav = wav[:, frame_offset:]
        if num_frames is not None and num_frames > 0:
            wav = wav[:, :num_frames]
        if not channels_first:
            wav = wav.transpose(0, 1)
        return wav, sample_rate

    torchaudio.load = _load
except Exception:  # 装不上也要能启动，缺什么由 api_v2 自己报
    pass
