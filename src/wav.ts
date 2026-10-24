/**
 * 参考音频的时长：api_v2 只收 3–10 秒的参考音频,超出时直接回 `400 Bad Request`,
 * 响应体里不带原因,用户只看到一个失败的语音。合成前先量一次,把原因说清楚。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** 只读文件头就够;`data` 块一般在 44 字节内,留 4 KB 容得下 `LIST` 之类的附加块。 */
const HEAD_BYTES = 4096;

/**
 * 从 RIFF 头算时长。`head` 是文件开头的一小段,`fileSize` 用于 `data` 长度写成 0(流式 WAV)的情况。
 * 不是 WAV 或头不完整时返回 null。
 */
export function secondsOf(head: Buffer, fileSize: number): number | null {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= head.length) {
    const id = head.toString('ascii', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= head.length) byteRate = head.readUInt32LE(at + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const dataStart = at + 8;
      // `data` 长度字段可能是 0(边写边播的文件),这时按文件实际剩下的字节算。
      const declared = size > 0 && dataStart + size <= fileSize ? size : fileSize - dataStart;
      return declared > 0 ? declared / byteRate : null;
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** 读文件头算时长;读不到(不是 WAV、文件损坏、没权限)时返回 null。 */
export function readSeconds(path: string): number | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'rb');
    const head = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, head, 0, head.length, 0);
    return secondsOf(head.subarray(0, read), statSync(path).size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 把单声道 PCM16 数据包成标准 44 字节头的 WAV，用来把合成结果落盘。 */
export function wavBytes(pcm: Buffer, sampleRate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
