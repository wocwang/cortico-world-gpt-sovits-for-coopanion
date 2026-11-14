import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CLOUD_VOICE_PAGE_SIZE, cloudListChrome, cloudManualSaveDisabled, cloudVoiceLabel, cloudVoicePage, showManualVoiceEntry } from '../src/cloud-voice-view.ts';
import { CLOUD_PROVIDERS, cloudProvider } from '../src/cloud-providers.ts';

const voices = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `V${i}` }));

describe('云端音色分页', () => {
  it('每页 7 条', () => {
    expect(CLOUD_VOICE_PAGE_SIZE).toBe(7);
    const pg = cloudVoicePage(voices(20), 1, '');
    expect(pg.items.map((v) => v.id)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(pg.page).toBe(1);
    expect(pg.pages).toBe(3);
    expect(pg.total).toBe(20);
  });

  it('末页不满也照常渲染', () => {
    const pg = cloudVoicePage(voices(20), 3, '');
    expect(pg.items.map((v) => v.id)).toEqual(['v14', 'v15', 'v16', 'v17', 'v18', 'v19']);
    expect(pg.pages).toBe(3);
  });

  it('空清单算 1 页且没有条目', () => {
    expect(cloudVoicePage([], 1, '')).toEqual({ items: [], page: 1, pages: 1, selectedPage: 0, total: 0 });
  });

  it('页码越界会夹回合法范围', () => {
    expect(cloudVoicePage(voices(9), 99, '').page).toBe(2);
    expect(cloudVoicePage(voices(9), 0, '').page).toBe(1);
    expect(cloudVoicePage(voices(9), -3, '').page).toBe(1);
    expect(cloudVoicePage(voices(9), 2.9, '').page).toBe(2);
  });

  it('选中的音色在别的页时给出它的页码，翻页不改选中', () => {
    const all = voices(20);
    const first = cloudVoicePage(all, 1, 'v15');
    expect(first.selectedPage).toBe(3);
    expect(first.items.some((v) => v.id === 'v15')).toBe(false);
    // 翻到那一页仍能看到它被选中（选中 id 不在计算里被改写）。
    const third = cloudVoicePage(all, first.selectedPage, 'v15');
    expect(third.items.map((v) => v.id)).toContain('v15');
    expect(third.selectedPage).toBe(3);
  });

  it('选中的音色不在清单里时为 0', () => {
    expect(cloudVoicePage(voices(3), 1, 'gone').selectedPage).toBe(0);
  });
});

describe('清单收起', () => {
  it('展开时渲染列表和「收起清单」，不显示摘要', () => {
    expect(cloudListChrome(false, 20, 3)).toEqual({
      showList: true, showCollapse: true, showSummary: false, showPager: true,
    });
  });

  it('收起后列表不渲染，只留摘要行和「展开清单」', () => {
    expect(cloudListChrome(true, 20, 3)).toEqual({
      showList: false, showCollapse: false, showSummary: true, showPager: false,
    });
  });

  it('清单为空时没有「收起清单」，空态照常显示', () => {
    expect(cloudListChrome(false, 0, 1)).toEqual({
      showList: true, showCollapse: false, showSummary: false, showPager: false,
    });
    // 即使误置成收起，也不允许把空态藏起来。
    expect(cloudListChrome(true, 0, 1).showList).toBe(true);
    expect(cloudListChrome(true, 0, 1).showSummary).toBe(false);
  });

  it('只有一页时不显示翻页条', () => {
    expect(cloudListChrome(false, 7, 1).showPager).toBe(false);
    expect(cloudListChrome(false, 8, 2).showPager).toBe(true);
  });

  it('收起不改变选中：页码仍指向原来那页，摘要显示同一个音色', () => {
    const all = voices(20);
    const before = cloudVoicePage(all, 1, 'v15');
    const after = cloudVoicePage(all, 1, 'v15');
    expect(after).toEqual(before);
    expect(after.selectedPage).toBe(3);
    expect(cloudVoiceLabel(all, 'v15')).toBe('V15');
    // 收起只决定渲染哪些块，输入里没有选中项，不会改写它。
    expect(cloudListChrome(true, before.total, before.pages).showSummary).toBe(true);
    expect(cloudVoiceLabel(all, 'v15')).toBe('V15');
  });

  it('摘要名称优先显示名，其次 id，没选时为空', () => {
    expect(cloudVoiceLabel([{ id: 'a', name: '晓晓' }], 'a')).toBe('晓晓');
    expect(cloudVoiceLabel([{ id: 'a', name: '' }], 'a')).toBe('a');
    expect(cloudVoiceLabel([{ id: 'a', name: 'A' }], ' gone ')).toBe('gone');
    expect(cloudVoiceLabel([], '')).toBe('');
  });
});

describe('手填音色 id 入口', () => {
  it('只给没有清单来源的厂商显示，判断来自厂商档案', () => {
    const shown = CLOUD_PROVIDERS
      .filter((p) => p.listed !== false && showManualVoiceEntry(p.voiceList))
      .map((p) => p.id)
      .sort();
    expect(shown).toEqual(['fish', 'mimo', 'minimax', 'openai', 'volcengine']);
    for (const id of ['custom', 'breeze', 'azure', 'elevenlabs']) {
      expect(showManualVoiceEntry(cloudProvider(id).voiceList)).toBe(false);
    }
  });

  it('id 为空或正在保存时按钮禁用', () => {
    expect(cloudManualSaveDisabled('')).toBe(true);
    expect(cloudManualSaveDisabled('   ')).toBe(true);
    expect(cloudManualSaveDisabled('female-shaonv')).toBe(false);
    expect(cloudManualSaveDisabled('  female-shaonv  ')).toBe(false);
    expect(cloudManualSaveDisabled('female-shaonv', true)).toBe(true);
  });
});

describe('手动新增区块已移除', () => {
  it('面板不再渲染显示名输入框与旧的「添加云端音色」按钮', async () => {
    const src = await readFile(new URL('../src/webui/client.ts', import.meta.url), 'utf8');
    for (const gone of ['cloudVoiceNamePh', 'cloudVoiceAdd', 'cloudAddFields', 'cloudAddHint', 'addCloudVoice']) {
      expect(src).not.toContain(gone);
    }
  });
});
