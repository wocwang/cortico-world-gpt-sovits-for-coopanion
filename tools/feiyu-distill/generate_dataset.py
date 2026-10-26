#!/usr/bin/env python3
"""在 WSL 的 CosyVoice 环境里批量生成肥鱼语音，做成 GPT-SoVITS 训练集。

一次加载模型，按 manifest.json 里的 cute/gentle 权重和参考音频逐句合成：

    out/
      wav/<id>.wav          24 kHz PCM16
      metadata.jsonl        id / text / lang / 时长 / 哈希
      list.txt              GPT-SoVITS 的 `wav|speaker|lang|text`（文件名，不带目录）
      errors.jsonl          失败的行与原因
      stats.json            句数、总时长、分语言统计

这个脚本只应在模型包要求的 WSL + CosyVoice 环境里运行；Windows 侧用
`run_generate.ps1` 调它。模型包和输出目录都由调用方指定，脚本不改模型包。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SPEAKER = "feiyu"
CHINESE = re.compile(r"[\u3400-\u9fff]")
MAX_CHARS = 80


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def detect_lang(text: str) -> str:
    return "zh" if CHINESE.search(text) else "en"


def read_corpus(path: Path) -> list[dict]:
    items: list[dict] = []
    if path.suffix.lower() == ".jsonl":
        for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            row = json.loads(line)
            text = str(row.get("text", "")).strip()
            lang = str(row.get("lang", "")).strip().lower() or detect_lang(text)
            if text:
                items.append({"line": line_no, "lang": lang, "text": text})
        return items
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "|" in line:
            lang, text = line.split("|", 1)
            lang = lang.strip().lower() or detect_lang(text)
            text = text.strip()
        else:
            text, lang = line, detect_lang(line)
        if text:
            items.append({"line": line_no, "lang": lang, "text": text})
    return items


def make_id(index: int, text: str) -> str:
    return f"{index:06d}-{hashlib.sha1(text.encode('utf-8')).hexdigest()[:8]}"


def append_jsonl(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_atomic(path: Path, text: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="批量生成肥鱼 CosyVoice3 训练数据（在 WSL 内运行）")
    parser.add_argument("--model-dir", required=True, type=Path, help="FeiyuVoice-CosyVoice3 包目录")
    parser.add_argument("--repo", required=True, type=Path, help="CosyVoice 仓库目录（runtime.local.json 的 repo）")
    parser.add_argument("--corpus", required=True, type=Path, help="JSONL 或纯文本语料")
    parser.add_argument("--out", required=True, type=Path, help="输出目录")
    parser.add_argument("--style", default="cute", choices=["cute", "gentle"])
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--limit", type=int, default=0, help="只生成前 N 句；0 为全部")
    parser.add_argument("--speed", type=float, default=None, help="默认用 manifest.json 里的 speed")
    parser.add_argument("--min-seconds", type=float, default=1.2)
    parser.add_argument("--max-seconds", type=float, default=12.0)
    parser.add_argument("--no-resume", action="store_true", help="忽略已有 metadata，重新生成")
    parser.add_argument("--verify", action="store_true", help="按 files_sha256.json 校验整个模型包（7.4GB，较慢）")
    args = parser.parse_args()

    model_dir = args.model_dir.resolve()
    out = args.out.resolve()
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"找不到模型包 manifest.json：{manifest_path}")
    manifest = load_json(manifest_path)
    if manifest.get("schema") != "feiyu-voice-local-release-v1":
        raise SystemExit("manifest schema 不是 feiyu-voice-local-release-v1")
    styles = manifest.get("styles", {})
    if args.style not in styles:
        raise SystemExit(f"模型包没有 {args.style} 风格；可选：{', '.join(styles)}")
    style = styles[args.style]
    inference = manifest.get("inference", {})
    prompt_prefix = str(inference.get("prompt_prefix", ""))
    default_speed = float(inference.get("speed", 1.0))
    speed = args.speed if args.speed is not None else default_speed

    checkpoint = (model_dir / style["llm_checkpoint"]).resolve()
    reference = (model_dir / style["reference_audio"]).resolve()
    base_model = (model_dir / manifest["base_model_dir"]).resolve()
    for path in (checkpoint, reference, base_model):
        if not path.exists():
            raise SystemExit(f"模型包缺文件：{path}")

    corpus = read_corpus(args.corpus.resolve())
    if args.limit:
        corpus = corpus[: args.limit]
    if not corpus:
        raise SystemExit("语料为空")

    out.mkdir(parents=True, exist_ok=True)
    wav_dir = out / "wav"
    wav_dir.mkdir(exist_ok=True)
    metadata_path = out / "metadata.jsonl"
    errors_path = out / "errors.jsonl"

    if args.no_resume and metadata_path.exists():
        metadata_path.unlink()
    done: dict[str, dict] = {}
    if metadata_path.exists():
        for line in metadata_path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip():
                row = json.loads(line)
                if (out / row["wav"]).is_file():
                    done[row["id"]] = row

    print(f"模型包：{model_dir}")
    print(f"风格：{args.style}（{style.get('candidate', '?')}）")
    print(f"语料：{len(corpus)} 句；已有 {len(done)} 句")
    print(f"CosyVoice：{args.repo}")

    if args.verify:
        checks = load_json(model_dir / "files_sha256.json")
        started = time.perf_counter()
        for index, (name, row) in enumerate(checks.items(), 1):
            path = (model_dir / name).resolve()
            if not path.is_file() or path.stat().st_size != row["bytes"] or sha256(path) != row["sha256"]:
                raise SystemExit(f"模型包校验失败：{name}")
            if index % 20 == 0 or index == len(checks):
                print(f"  校验 {index}/{len(checks)}")
        print(f"模型包校验通过（{time.perf_counter() - started:.1f}s）")

    checkpoint_sha = sha256(checkpoint)
    reference_sha = sha256(reference)
    if checkpoint_sha != style["llm_sha256"]:
        raise SystemExit("风格 checkpoint 哈希与 manifest 不一致")
    if reference_sha != style["reference_sha256"]:
        raise SystemExit("参考音频哈希与 manifest 不一致")

    repo = args.repo.resolve()
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    sys.path.append(str(repo / "third_party" / "Matcha-TTS"))
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1", OMP_NUM_THREADS="4")

    import numpy as np
    import soundfile as sf
    import torch
    from cosyvoice.cli.cosyvoice import AutoModel
    from cosyvoice.utils.common import set_all_random_seed

    if not torch.cuda.is_available():
        print("警告：CUDA 不可用，将退回 CPU，生成会非常慢。", file=sys.stderr)
    else:
        print(f"GPU：{torch.cuda.get_device_name(0)}；torch {torch.__version__}")
    torch.set_num_threads(4)

    started = time.perf_counter()
    voice = AutoModel(model_dir=str(base_model), fp16=False, load_trt=False, load_vllm=False)
    base_llm = base_model / "llm.pt"
    if checkpoint != base_llm:
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        voice.model.llm.load_state_dict(state, strict=True)
        del state
    voice.model.llm.eval()
    print(f"模型加载完成（{time.perf_counter() - started:.1f}s），采样率 {voice.sample_rate}")

    written = 0
    skipped = 0
    for index, item in enumerate(corpus):
        text = " ".join(item["text"].split())
        lang = item.get("lang") or detect_lang(text)
        if lang not in {"zh", "en"}:
            skipped += 1
            append_jsonl(errors_path, {"line": item.get("line"), "text": text, "reason": f"不支持的语言 {lang}"})
            continue
        if len(text) > MAX_CHARS:
            skipped += 1
            append_jsonl(errors_path, {"line": item.get("line"), "text": text, "reason": f"超过 {MAX_CHARS} 字"})
            continue
        identifier = make_id(index, text)
        if identifier in done:
            skipped += 1
            continue
        wav_path = wav_dir / f"{identifier}.wav"
        if wav_path.exists() and wav_path.stat().st_size > 44:
            skipped += 1
            continue
        line_started = time.perf_counter()
        try:
            set_all_random_seed(args.seed + index)
            with torch.inference_mode():
                chunks = [
                    part["tts_speech"].detach().cpu().numpy()[0]
                    for part in voice.inference_zero_shot(
                        text,
                        prompt_prefix + style["reference_text"],
                        str(reference),
                        stream=False,
                        speed=speed,
                        text_frontend=True,
                    )
                ]
            if not chunks:
                raise RuntimeError("模型没有返回音频")
            audio = np.concatenate(chunks)
            if not audio.size or not np.isfinite(audio).all() or float(np.abs(audio).max()) < 1e-4:
                raise RuntimeError("音频为空或接近静音")
            seconds = len(audio) / voice.sample_rate
            if seconds < args.min_seconds or seconds > args.max_seconds:
                raise RuntimeError(f"时长 {seconds:.2f}s 不在 {args.min_seconds}-{args.max_seconds}s")
            peak = float(abs(audio).max())
            audio = audio * min(1.0, 0.98 / peak)
            sf.write(wav_path, audio, voice.sample_rate, subtype="PCM_16")
            row = {
                "id": identifier,
                "style": args.style,
                "lang": lang,
                "text": text,
                "wav": f"wav/{identifier}.wav",
                "seconds": round(seconds, 3),
                "sample_rate": voice.sample_rate,
                "seed": args.seed + index,
                "checkpoint": style["llm_checkpoint"],
                "checkpoint_sha256": checkpoint_sha,
                "reference": style["reference_audio"],
                "reference_sha256": reference_sha,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            append_jsonl(metadata_path, row)
            done[identifier] = row
            written += 1
            if written % 10 == 0 or written == 1:
                elapsed = time.perf_counter() - line_started
                print(f"[{index + 1}/{len(corpus)}] {identifier} {seconds:.2f}s / {elapsed:.2f}s  {text[:24]}")
        except Exception as exc:
            skipped += 1
            append_jsonl(errors_path, {"line": item.get("line"), "text": text, "reason": str(exc)})
            print(f"[跳过] {text[:24]}：{exc}", file=sys.stderr)

    rows = list(done.values())
    list_lines = [
        f"{Path(row['wav']).name}|{SPEAKER}|{row['lang']}|{row['text']}"
        for row in rows
    ]
    write_atomic(out / "list.txt", "\n".join(list_lines) + ("\n" if list_lines else ""))
    stats = {
        "style": args.style,
        "sentences": len(rows),
        "seconds": round(sum(float(row["seconds"]) for row in rows), 3),
        "by_lang": {lang: sum(1 for row in rows if row["lang"] == lang) for lang in ("zh", "en")},
        "manifest_version": manifest.get("version"),
        "checkpoint_sha256": checkpoint_sha,
        "reference_sha256": reference_sha,
        "new": written,
        "skipped": skipped,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    write_atomic(out / "stats.json", json.dumps(stats, ensure_ascii=False, indent=2) + "\n")
    print(
        f"完成：新增 {written} 句，跳过 {skipped} 句，共 {stats['sentences']} 句 / "
        f"{stats['seconds'] / 60:.1f} 分钟；{out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
