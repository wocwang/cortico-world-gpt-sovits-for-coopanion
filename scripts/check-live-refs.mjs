/**
 * 检测运行中的 Coopanion 是否按「语音语言」换用了正确的预设参考音频与台本。
 *
 *   pnpm check:refs            只查配置与随包文件
 *   pnpm check:refs -- --tts    再向正在跑的 api_v2 发一句测试（不播放）
 *
 * 读取的是部署里的 config.json；默认路径可用 --config 覆盖。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSeconds } from '../src/wav.ts';
import { promptLanguageOf } from '../src/speech-text.ts';
import { presetRefId, isPreset } from '../src/voices.ts';

const DEFAULT_CONFIG = 'D:/Program Files/Coopanion/data/home/companion/config.json';
const args = process.argv.slice(2);
const configPath = (() => {
  const at = args.indexOf('--config');
  return at >= 0 ? args[at + 1] : DEFAULT_CONFIG;
})();
const wantTts = args.includes('--tts');

const pass = (text) => console.log(`  PASS  ${text}`);
const fail = (text) => { console.log(`  FAIL  ${text}`); process.exitCode = 1; };
const info = (text) => console.log(`        ${text}`);

if (!existsSync(configPath)) {
  console.error(`找不到配置：${configPath}`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const w = config.worlds?.['gpt-sovits'];
if (!w) {
  console.error(`配置里没有 worlds.gpt-sovits：${configPath}`);
  process.exit(2);
}

const textLang = w.textLang ?? '(缺省)';
const preset = w.voice?.preset ?? '(空)';
const audio = (w.voice?.audio ?? '').trim();
const text = (w.voice?.text ?? '').trim();
console.log(`配置：${configPath}`);
console.log(`语音语言：${textLang} | 音色：${preset}`);

let ok = true;
if (!isPreset(preset)) {
  fail(`当前音色不是预设（${preset}），分语言参考只对预设生效`);
  ok = false;
} else {
  const expectedName = presetRefId(preset, textLang === 'auto' ? 'auto' : textLang);
  const expected = audio ? join(dirname(audio), `${expectedName}.wav`) : '';
  info(`应按 ${textLang} 使用：${expectedName}.wav`);
  if (audio && basename(audio) === `${expectedName}.wav` && existsSync(audio)) pass(`当前参考：${basename(audio)}`);
  else fail(`当前参考：${audio ? basename(audio) : '(空)'}，应为 ${expectedName}.wav（${expected}）`);
  const txt = audio.replace(/\.wav$/i, '.txt');
  if (existsSync(txt)) {
    const actual = readFileSync(txt, 'utf8').trim();
    if (actual === text) pass(`台本与 ${basename(txt)} 一致（${[...text].length} 字）`);
    else fail(`配置里的台本与 ${basename(txt)} 不一致`);
    info(`台本语言判断：${promptLanguageOf(actual)}`);
  } else {
    fail(`找不到台本：${txt}`);
  }
  if (existsSync(audio)) {
    const seconds = readSeconds(audio);
    if (seconds !== null && seconds >= 3 && seconds <= 10) pass(`参考时长：${seconds.toFixed(2)} s（要求 3–10 s）`);
    else fail(`参考时长不合要求：${seconds === null ? '读不出' : `${seconds.toFixed(2)} s`}`);
  }
}

const dir = audio ? dirname(audio) : '';
if (dir) {
  console.log('该音色在各语言下的参考：');
  for (const lang of ['zh', 'en', 'ja', 'auto']) {
    const name = presetRefId(preset, lang);
    const file = join(dir, `${name}.wav`);
    info(`${lang.padEnd(4)} -> ${name}.wav ${existsSync(file) ? '✓' : '(缺，回退默认)'}`);
  }
}

if (wantTts) {
  const probe = (() => {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'api_v2' -and $_.CommandLine -match 'gpt-sovits' } | Select-Object -ExpandProperty CommandLine",
      ], { encoding: 'utf8' });
      const ports = [...out.matchAll(/-p\s+(\d+)/g)].map((m) => Number(m[1]));
      return ports.at(-1) ?? null;
    } catch {
      return null;
    }
  })();
  if (!probe) {
    fail('没找到正在跑的 api_v2（用自备服务时请手动确认）');
  } else {
    info(`api_v2 端口：${probe}`);
    const lang = textLang === 'auto' ? 'zh' : textLang;
    const sample = { zh: '你好呀，我现在可以说话啦。', en: 'Hello, I can talk now.', ja: 'こんにちは、話せるようになりました。' }[lang] ?? '你好呀，我现在可以说话啦。';
    const body = JSON.stringify({
      text: sample, text_lang: lang, ref_audio_path: audio, prompt_text: text,
      prompt_lang: promptLanguageOf(text), text_split_method: 'cut5', batch_size: 1, media_type: 'wav', streaming_mode: 0,
    });
    const bodyFile = join(tmpdir(), 'check-live-refs.json');
    const outFile = join(tmpdir(), 'check-live-refs.wav');
    writeFileSync(bodyFile, body, 'utf8');
    const started = Date.now();
    const res = execFileSync('curl.exe', ['-s', '-o', outFile, '-w', '%{http_code} %{size_download}',
      '-X', 'POST', `http://127.0.0.1:${probe}/tts`, '-H', 'content-type: application/json', '--data-binary', `@${bodyFile}`,
    ], { encoding: 'utf8' });
    const ms = Date.now() - started;
    const [code, size] = res.trim().split(/\s+/);
    if (code === '200' && Number(size) > 1000) pass(`测试合成：HTTP ${code}，${Number(size)} 字节，${ms} ms`);
    else fail(`测试合成：HTTP ${code}，${size} 字节`);
    info(`测试音频：${outFile}`);
  }
}

console.log(ok && !process.exitCode ? '\n结果：通过。' : '\n结果：有问题，见上。');
