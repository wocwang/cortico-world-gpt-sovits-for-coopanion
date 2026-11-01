#!/usr/bin/env bash
# 打一档运行时包:bash scripts/build-runtime.sh <cu128|cpu|rocm> <工作目录>
#
# 产物 <工作目录>/gpt-sovits-<RUNTIME_VERSION>-win-x64-<档>.zip,解压后是 runtime 根:上游 GPT-SoVITS 在
# UPSTREAM_COMMIT 的代码、runtime/(python-build-standalone 的 CPython 3.12 加依赖)、G2PW、NLTK 数据、Open JTalk 词典。
# GPT_SoVITS/pretrained_models 留空，启动前由扩展接到权重目录。另出 1900 MiB 的分片(GitHub Release 单个附件上限 2 GiB)。
# 要 git、uv、curl、Windows 自带的 tar.exe;只在 Windows x64 上跑。
#
# rocm 档：torch/torchaudio 从 AMD 官方 wheel 索引装 ROCm 版，四套官方架构的内核包一次装齐
# （gfx1100/1101/1200/1201）；不装 flash-attn（cu128 编译的扩展会让 GPT-SoVITS 挂上 CUDA graph 后端）。
set -euo pipefail
TIER="$1"
case "$TIER" in
  cu128|cpu|rocm) ;;
  *) echo "usage: $0 <cu128|cpu|rocm> <work dir>" >&2; exit 2 ;;
esac
WORK="$(mkdir -p "$2" && cd "$2" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMMIT=$(sed -nE "s/^export const UPSTREAM_COMMIT = '([0-9a-f]+)';/\1/p" "$HERE/../src/catalog.ts")
VERSION=$(sed -nE "s/^export const RUNTIME_VERSION = '([^']+)';/\1/p" "$HERE/../src/catalog.ts")
TAR=/c/Windows/System32/tar.exe
MS=https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master
NAME="gpt-sovits-$VERSION-win-x64-$TIER"
OUT="$WORK/$NAME"

# 上游代码
[ -d "$WORK/upstream" ] || git clone -q https://github.com/RVC-Boss/GPT-SoVITS.git "$WORK/upstream"
git -C "$WORK/upstream" fetch -q origin "$COMMIT" 2>/dev/null || git -C "$WORK/upstream" fetch -q origin
rm -rf "$OUT" && mkdir -p "$OUT"
git -C "$WORK/upstream" archive "$COMMIT" | "$TAR" -x -C "$OUT"
rm -rf "$OUT/docs" "$OUT/Docker" "$OUT"/*.ipynb "$OUT/Dockerfile" "$OUT/docker-compose.yaml"
# 上游这个 commit 把 AR 放在 GPT_SoVITS/AR：运行时靠 sys.path 里的 GPT_SoVITS 找到它，
# 但打包后仍要求归档里确实有这一份；缺了就说明归档不完整，直接失败。
if [ ! -f "$OUT/GPT_SoVITS/AR/models/t2s_lightning_module.py" ]; then
  echo "archive is missing GPT_SoVITS/AR" >&2
  exit 1
fi
# 根目录再放一份，兼容其他按顶层 `from AR...` 导入的入口。
[ -d "$OUT/AR" ] || cp -r "$OUT/GPT_SoVITS/AR" "$OUT/AR"
# tools/asr 与 tools/uvr5 保留:训练面板要起 WebUI,webui.py 启动即 import tools.asr(缺了直接退)。
# 两边的大权重都不在 git 归档里,无需另删。

# 独立 CPython:._pth 把运行时根(..)放进 sys.path,因为 -I 下脚本目录不在里面
uv python install 3.12 --no-bin --install-dir "$WORK/python" >/dev/null
PYSRC=$(ls -d "$WORK"/python/cpython-3.12.*-windows-x86_64-none | grep -v -- '-3\.12-' | head -1)
cp -r "$PYSRC" "$OUT/runtime"
rm -f "$OUT/runtime/Lib/EXTERNALLY-MANAGED"
printf 'DLLs\r\nLib\r\nLib\\site-packages\r\n..\r\nimport site\r\n' > "$OUT/runtime/python312._pth"

PIP=(uv pip install --python "$OUT/runtime/python.exe" --link-mode copy)
if [ "$TIER" = cu128 ]; then
  "${PIP[@]}" torch==2.7.1+cu128 torchaudio==2.7.1+cu128 --index-url https://download.pytorch.org/whl/cu128
  "${PIP[@]}" "flash-attn @ https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/wheels/cu128/flash_attn-2.8.3%2Bcu12torch2.7cxx11abiFALSE-cp312-cp312-win_amd64.whl"
elif [ "$TIER" = rocm ]; then
  # --upgrade 不能省：不升级时 pip 认为已装的 cpu 版 torch 已满足要求，extras 不触发安装，只会空转。
  # extras 决定装哪几套内核包；少一套，对应架构的机器会在第一个卷积报 hipErrorInvalidKernelFile。
  # numpy 钉 <2：pyopenjtalk 在 numpy 2.x 下会崩。
  "${PIP[@]}" --upgrade --index-url https://stable.repo.amd.com/rocm/whl-next/ \
    "torch[device-gfx1100,device-gfx1101,device-gfx1200,device-gfx1201]" torchaudio "numpy<2"
else
  "${PIP[@]}" torch==2.7.1+cpu torchaudio==2.7.1+cpu --index-url https://download.pytorch.org/whl/cpu
fi
# onnxruntime 只给中文多音字模型 G2PW 用，各档都用 CPU 版(GPU 版多 500 MB 以上)
"${PIP[@]}" "onnxruntime==1.19.2"
"${PIP[@]}" -r "$HERE/requirements-infer.txt"

if [ "$TIER" = rocm ]; then
  ROCM_SP="$OUT/runtime/Lib/site-packages"
  # 四套架构的内核包缺一套，对应显卡就在第一个卷积报 hipErrorInvalidKernelFile；装不全不打包。
  for arch in gfx1100 gfx1101 gfx1200 gfx1201; do
    ls -d "$ROCM_SP"/*device*"$arch"* >/dev/null 2>&1 || { echo "missing device kernels for $arch" >&2; exit 1; }
  done
  # cu128 编译的 flash-attn 会让上游挂上 flash-attn / CUDA graph 后端（importlib.util.find_spec 探测）。
  if [ -e "$ROCM_SP/flash_attn" ]; then echo "flash_attn must not ship in the rocm tier" >&2; exit 1; fi
  # torchaudio >= 2.9 的 load 只走 TorchCodec；用 soundfile 兜底（构建期写入，不是运行期改包）。
  cp "$HERE/rocm-sitecustomize.py" "$ROCM_SP/sitecustomize.py"
fi

# 文本前端的数据
mkdir -p "$WORK/archives"
for f in G2PWModel.zip nltk_data.zip open_jtalk_dic_utf_8-1.11.tar.gz; do
  [ -s "$WORK/archives/$f" ] || curl -fsSL -o "$WORK/archives/$f" "$MS/$f"
done
"$TAR" -xf "$WORK/archives/G2PWModel.zip" -C "$OUT/GPT_SoVITS/text"
"$TAR" -xf "$WORK/archives/nltk_data.zip" -C "$OUT/runtime"
"$TAR" -xzf "$WORK/archives/open_jtalk_dic_utf_8-1.11.tar.gz" -C "$OUT/runtime/Lib/site-packages/pyopenjtalk"

# 推理用不到的：调试符号、链接库、C 头文件、字节码缓存;权重目录清空
SP="$OUT/runtime/Lib/site-packages"
find "$OUT" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$SP" \( -name '*.pdb' -o -name '*.lib' \) -delete
rm -rf "$SP/torch/include" "$OUT/runtime/include" "$OUT/runtime/libs" "$OUT/runtime/tcl"
rm -rf "$OUT/GPT_SoVITS/pretrained_models" && mkdir -p "$OUT/GPT_SoVITS/pretrained_models"

# 打包与分片
ZIP="$WORK/$NAME.zip"
rm -f "$ZIP" "$ZIP".part*
(cd "$OUT" && "$TAR" -a -c -f "$ZIP" *)
split -b 1900m -d -a 1 "$ZIP" "$ZIP.part"
BYTES=$(stat -c %s "$ZIP")
SHA=$(sha256sum "$ZIP" | cut -d' ' -f1)
echo "unpacked $(du -sm "$OUT" | cut -f1) MiB"
echo "$NAME.zip bytes=$BYTES sha256=$SHA"
for p in "$ZIP".part*; do echo "  $(basename "$p") bytes=$(stat -c %s "$p")"; done
