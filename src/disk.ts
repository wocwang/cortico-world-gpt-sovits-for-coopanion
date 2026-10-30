/**
 * 统计目录占用。
 *
 * `dirBytes` 递归到底，跳过目录联接/符号链接：运行时的 `GPT_SoVITS/pretrained_models` 是指向权重目录的联接，
 * 跟着走会把同一份权重算两遍。只适合文件不多的目录（权重几十个文件）；运行时那种几万个文件的目录要算几十秒，
 * 面板里改用 `RUNTIME_EXTRACT_BYTES` 的实测估算。
 * `topLevelBytes` 只统计目录下第一层的文件，用来量没下完的压缩包这类东西。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isLinkEntry } from './install.ts';

export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (isLinkEntry(child)) continue;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      try {
        total += statSync(child).size;
      } catch {
        // 扫描期间被删掉/占用的文件，跳过就好。
      }
    }
  };
  walk(dir);
  return total;
}

/** 只累加第一层的普通文件（不递归）；目录与联接不算。 */
export function topLevelBytes(dir: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += statSync(join(dir, entry.name)).size;
    } catch { /* 刚被删掉 */ }
  }
  return total;
}
