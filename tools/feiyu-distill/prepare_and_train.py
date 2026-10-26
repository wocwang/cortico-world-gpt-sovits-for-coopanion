#!/usr/bin/env python3
r"""用肥鱼 CosyVoice3 生成的语音试训一个 GPT-SoVITS v2ProPlus 音色。

流程与 GPT-SoVITS WebUI 的 1A/1B 一致：

  1. 数据集预处理：1-get-text / 2-get-hubert-wav32k / 2-get-sv / 3-get-semantic
  2. SoVITS(s2) 训练
  3. GPT(s1) 训练

默认用本插件已经装好的 CUDA 运行时；只跑 v2ProPlus（试训先验证音色，不碰 v5 LoRA）。
脚本只写工作目录和权重输出目录，不改运行时和托管权重，也不联网下载任何东西。
基础权重需要你事先放到本地（见 README）。

示例：

  python tools/feiyu-distill/prepare_and_train.py ^
      --dataset D:\feiyu-data\pilot ^
      --s2-epochs 2 --s1-epochs 4 --batch-size 8

  # 只生成配置和命令，不执行：
  python tools/feiyu-distill/prepare_and_train.py --dataset ... --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

DEFAULT_RUNTIME = Path(r"D:\Program Files\Coopanion\data\home\runtimes\gpt-sovits\e91506f-1\cuda")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def log_line(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(text.rstrip() + "\n")


def find(work: Path, pretrained: Path, relative: str) -> Path:
    """先在运行时 pretrained_models 找，再在工作目录的 pretrained 里找。"""
    for root in (pretrained, work / "pretrained"):
        path = root / relative
        if path.is_file():
            return path
    raise SystemExit(
        f"缺少 {relative}。把它放到 {work / 'pretrained' / relative}，"
        f"或放进运行时的 {pretrained / relative}。脚本不联网下载。"
    )


def ensure_shared(runtime: Path, work: Path) -> dict[str, Path]:
    pretrained = runtime / "GPT_SoVITS" / "pretrained_models"
    s1 = find(work, pretrained, "s1v3.ckpt")
    dirs = {
        "bert": pretrained / "chinese-roberta-wwm-ext-large",
        "hubert": pretrained / "chinese-hubert-base",
    }
    for label, path in dirs.items():
        if not path.is_dir():
            raise SystemExit(f"缺少 {label} 目录：{path}。请用完整运行时，或把上游 pretrained_models 放进去。")
    return {"s1": s1, **dirs}


def ensure_v2proplus(runtime: Path, work: Path) -> dict[str, Path]:
    pretrained = runtime / "GPT_SoVITS" / "pretrained_models"
    return {
        "s2": find(work, pretrained, "v2Pro/s2Gv2ProPlus.pth"),
        "sv": find(work, pretrained, "sv/pretrained_eres2netv2w24s4ep4.ckpt"),
    }


def read_metadata(dataset: Path) -> list[dict]:
    path = dataset / "metadata.jsonl"
    if not path.is_file():
        raise SystemExit(f"缺少 {path}；先生成数据集")
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rel = Path(row.get("wav", ""))
        wav = rel if rel.is_absolute() else dataset / rel
        if not wav.is_file():
            raise SystemExit(f"缺少音频：{wav}")
        text = str(row.get("text", "")).strip()
        lang = str(row.get("lang", "")).strip()
        if not text or lang not in {"zh", "en"}:
            continue
        rows.append({**row, "wav": wav, "text": text, "lang": lang})
    if not rows:
        raise SystemExit("metadata.jsonl 里没有可用的 zh/en 行")
    return rows


def write_list(rows: list[dict], path: Path) -> None:
    lines = [
        f"{row['wav'].name}|feiyu|{row['lang']}|{row['text']}"
        for row in rows
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def merge_parts(exp: Path) -> None:
    """把 -0 分片合并成训练脚本要的无后缀文件。"""
    for source, target in (
        (exp / "2-name2text-0.txt", exp / "2-name2text.txt"),
        (exp / "6-name2semantic-0.tsv", exp / "6-name2semantic.tsv"),
    ):
        if source.is_file():
            target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            source.unlink()


def run(cmd: list[str], cwd: Path, env: dict[str, str], log: Path) -> None:
    log_line(log, "$ " + " ".join(cmd))
    with log.open("a", encoding="utf-8") as stream:
        process = subprocess.run(cmd, cwd=str(cwd), env=env, stdout=stream, stderr=subprocess.STDOUT, text=True)
    if process.returncode != 0:
        tail = "\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-40:])
        raise SystemExit(f"命令失败（退出码 {process.returncode}），日志 {log}：\n{tail}")


def check_python(python: Path) -> None:
    if not python.is_file():
        raise SystemExit(f"找不到训练用 Python：{python}")
    module = subprocess.run(
        [str(python), "-c", "import tensorboard, peft, pytorch_lightning"],
        capture_output=True,
        text=True,
    )
    if module.returncode == 0:
        return
    raise SystemExit(
        "训练环境缺 tensorboard/peft/pytorch_lightning。先手动运行：\n"
        f'  "{python}" -m pip install tensorboard\n'
        "（peft / pytorch_lightning 完整运行时通常已经带了。）"
    )


def write_s2_config(gpt: Path, work: Path, base: Path, args: argparse.Namespace) -> Path:
    source = gpt / "configs" / "s2v2ProPlus.json"
    config = json.loads(source.read_text(encoding="utf-8"))
    config["train"].update(
        {
            "batch_size": args.batch_size,
            "epochs": args.s2_epochs,
            "pretrained_s2G": str(base),
            "pretrained_s2D": "",
            "if_save_latest": True,
            "if_save_every_weights": True,
            "save_every_epoch": 1,
            "gpu_numbers": args.gpu,
            "grad_ckpt": False,
            "lora_rank": 32,
        }
    )
    config["model"]["version"] = "v2ProPlus"
    config["data"]["exp_dir"] = str(work / "exp")
    config["s2_ckpt_dir"] = str(work / "exp")
    config["save_weight_dir"] = str(work / "weights")
    config["name"] = "feiyu_trial"
    config["version"] = "v2ProPlus"
    path = work / "tmp_s2.json"
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_s1_config(work: Path, s1: Path, args: argparse.Namespace) -> Path:
    text = f"""train:
  seed: 1234
  epochs: {args.s1_epochs}
  batch_size: {args.batch_size}
  save_every_n_epoch: 1
  precision: 16-mixed
  gradient_clip: 1.0
  if_save_latest: true
  if_save_every_weights: true
  if_dpo: false
  half_weights_save_dir: {json.dumps(str(work / 'weights'))}
  exp_name: feiyu_trial
optimizer:
  lr: 0.01
  lr_init: 0.00001
  lr_end: 0.0001
  warmup_steps: 2000
  decay_steps: 40000
data:
  max_eval_sample: 8
  max_sec: 54
  num_workers: 4
  pad_val: 1024
model:
  vocab_size: 1025
  phoneme_vocab_size: 732
  embedding_dim: 512
  hidden_dim: 512
  head: 16
  linear_units: 2048
  n_layer: 24
  dropout: 0
  EOS: 1024
  random_bert: 0
inference:
  top_k: 15
pretrained_s1: {json.dumps(str(s1))}
train_semantic_path: {json.dumps(str(work / 'exp' / '6-name2semantic.tsv'))}
train_phoneme_path: {json.dumps(str(work / 'exp' / '2-name2text.txt'))}
output_dir: {json.dumps(str(work / 'logs_s1_v2ProPlus'))}
"""
    path = work / "tmp_s1.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="用肥鱼生成数据试训 GPT-SoVITS v2ProPlus")
    parser.add_argument("--dataset", required=True, type=Path, help="generate_dataset.py 的输出目录")
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME, help="插件 CUDA 运行时根目录")
    parser.add_argument("--work", type=Path, default=None, help="试训工作目录，默认 <dataset>/trial")
    parser.add_argument("--s2-epochs", type=int, default=2)
    parser.add_argument("--s1-epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--gpu", default="0", help="CUDA_VISIBLE_DEVICES，如 0 或 0,1")
    parser.add_argument("--stage", choices=["prepare", "s2", "s1", "all"], default="all")
    parser.add_argument("--min-minutes", type=float, default=3.0, help="低于这个时长只警告；--force 可继续")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="只检查路径、写配置、打印命令")
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    runtime = args.runtime.resolve()
    work = (args.work or dataset / "trial").resolve()
    gpt = runtime / "GPT_SoVITS"
    python = runtime / "runtime" / "python.exe"
    if not gpt.is_dir():
        raise SystemExit(f"运行时里没有 GPT_SoVITS：{gpt}")
    work.mkdir(parents=True, exist_ok=True)
    (work / "exp").mkdir(exist_ok=True)
    (work / "weights").mkdir(exist_ok=True)
    (work / "logs_s1_v2ProPlus").mkdir(exist_ok=True)
    log = work / "train.log"

    rows = read_metadata(dataset)
    total = sum(float(row.get("seconds", 0) or 0) for row in rows)
    print(f"数据集：{len(rows)} 句 / {total / 60:.1f} 分钟（{dataset}）")
    if total and total < args.min_minutes * 60 and not args.force:
        raise SystemExit(f"数据只有 {total / 60:.1f} 分钟，少于 {args.min_minutes} 分钟；确认要试训请加 --force")
    list_path = work / "list.txt"
    write_list(rows, list_path)

    shared = ensure_shared(runtime, work)
    base = ensure_v2proplus(runtime, work)
    s2_config = write_s2_config(gpt, work, base["s2"], args)
    s1_config = write_s1_config(work, shared["s1"], args)
    print(f"配置：{s2_config} / {s1_config}")

    env = os.environ.copy()
    env.update(
        {
            "inp_text": str(list_path),
            "inp_wav_dir": str(dataset / "wav"),
            "exp_name": "trial",
            "opt_dir": str(work / "exp"),
            "i_part": "0",
            "all_parts": "1",
            "bert_pretrained_dir": str(shared["bert"]),
            "cnhubert_base_dir": str(shared["hubert"]),
            "pretrained_s2G": str(base["s2"]),
            "s2config_path": str(gpt / "configs" / "s2v2ProPlus.json"),
            "sv_path": str(base["sv"]),
            "version": "v2ProPlus",
            "is_half": "True",
            "_CUDA_VISIBLE_DEVICES": args.gpu,
            "PYTHONPATH": f"{runtime};{gpt};{gpt / 'eres2net'}",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    prepare = [
        ("1-get-text.py", "1-get-text.log"),
        ("2-get-hubert-wav32k.py", "2-get-hubert.log"),
        ("2-get-sv.py", "2-get-sv.log"),
        ("3-get-semantic.py", "3-get-semantic.log"),
    ]
    commands = []
    if args.stage in {"prepare", "all"}:
        for script, name in prepare:
            commands.append(([str(python), "-s", f"GPT_SoVITS/prepare_datasets/{script}"], runtime, env, work / "logs" / name, "prepare"))
    if args.stage in {"s2", "all"}:
        commands.append(([str(python), "-s", "GPT_SoVITS/s2_train.py", "--config", str(s2_config)], runtime, env, work / "logs" / "s2.log", "s2"))
    if args.stage in {"s1", "all"}:
        commands.append(([str(python), "-s", "GPT_SoVITS/s1_train.py", "--config_file", str(s1_config)], runtime, env, work / "logs" / "s1.log", "s1"))

    if args.dry_run:
        for cmd, cwd, _, file, _ in commands:
            print(f"[dry-run] (cwd={cwd}) " + " ".join(f'"{part}"' if " " in part else part for part in cmd))
        print(f"[dry-run] 日志目录：{work / 'logs'}")
        return 0

    check_python(python)
    if args.stage in {"prepare", "all"}:
        for cmd, cwd, env2, file, stage in commands:
            if stage != "prepare":
                continue
            run(cmd, cwd, env2, file)
            merge_parts(work / "exp")
    for cmd, cwd, env2, file, stage in commands:
        if stage == "prepare":
            continue
        run(cmd, cwd, env2, file)
    print(f"完成。权重在 {work / 'weights'}")
    for path in sorted((work / "weights").glob("*")):
        print(f"  {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
