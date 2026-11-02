/**
 * 音频后端的真机自检：随包的 audify 只接受**正好一帧**的 PCM，多一帧、少一字节都抛
 * `Invalid size of the PCM data!`。0.6.4 的后端探针送了两帧，抛错被吞 → 两只后端都被判死 →
 * 那一版在 Windows 上全员静音。这个脚本把「一帧能写、两帧必抛」钉住，
 * 发布前跑一次，别再靠单测里的长度算式兜底。
 *
 * 用法：`npm run check:audio`（需要机器上有播放设备；没有设备会打印原因并跳过）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('../vendor/audify/audify.node');
const RtAudio = binding.RtAudio ?? binding;
const RTAUDIO_SINT16 = 0x2;

/** 插件用 40 ms 一帧（FRAME_MS），与 `src/player.ts` 一致。 */
const FRAME_MS = 40;
const SAMPLE_RATE = 32000;
const frameSize = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);

let failures = 0;

for (const [api, label] of [[7, 'WASAPI'], [8, 'DirectSound']]) {
  let rt;
  try {
    rt = new RtAudio(api);
    const devices = rt.getDevices().filter((d) => d.outputChannels > 0);
    const preferred = rt.getDefaultOutputDevice();
    const device = devices.find((d) => d.id === preferred) ?? devices[0];
    if (!device) {
      console.log(`${label}: 没有播放设备，跳过`);
      continue;
    }
    const channels = Math.min(2, Math.max(1, device.outputChannels));
    rt.openStream(
      { deviceId: device.id, nChannels: channels, firstChannel: 0 },
      null,
      RTAUDIO_SINT16,
      SAMPLE_RATE,
      frameSize,
      'cortico-gpt-sovits-check',
      null,
      null,
    );
    rt.start();
    const oneFrame = frameSize * channels * 2;
    let ok = false;
    try {
      rt.write(Buffer.alloc(oneFrame));
      ok = true;
    } catch (err) {
      console.log(`${label}: 一帧写入失败（${oneFrame} 字节）：${String(err)}`);
    }
    let twoFramesThrew = false;
    try {
      rt.write(Buffer.alloc(oneFrame * 2));
    } catch {
      twoFramesThrew = true;
    }
    const running = typeof rt.isStreamRunning === 'function' ? rt.isStreamRunning() : null;
    console.log(`${label}: channels=${channels} 一帧=${oneFrame}B 写入=${ok} 两帧被拒=${twoFramesThrew} isStreamRunning=${running}`);
    if (!ok || !twoFramesThrew) failures += 1;
    try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已经断开 */ }
  } catch (err) {
    console.log(`${label}: 打不开流（${String(err).slice(0, 120)}），跳过`);
  }
}

if (failures) {
  console.error(`自检失败：${failures} 个后端的帧长行为与预期不符，别发版。`);
  process.exit(1);
}
console.log('自检通过：一帧能写、两帧被拒，与插件的帧长算法一致。');
