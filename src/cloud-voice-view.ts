/**
 * 「音色」页云端清单的纯展示状态：分页。
 *
 * 单独放在这里是为了能直接测：翻页只改本地页码，不重置已选中的音色、也不重新发请求。
 */
import type { CloudVoice } from './cloud-voices.ts';

/** 每页条数；列表很长时只渲染这一页。 */
export const CLOUD_VOICE_PAGE_SIZE = 7;

export interface CloudVoicePageState {
  /** 当前页要渲染的音色。 */
  items: CloudVoice[];
  /** 实际使用的页码（1 起；越界会夹到合法范围）。 */
  page: number;
  /** 总页数；空清单也算 1 页。 */
  pages: number;
  /** 已选中音色所在的页码；不在清单里为 0。 */
  selectedPage: number;
  /** 清单一共多少条。 */
  total: number;
}

/** 算出当前页；页码越界时自动夹回，避免清单变短后停在空白页。 */
export function cloudVoicePage(
  voices: ReadonlyArray<CloudVoice>,
  page: number,
  selectedId: string,
): CloudVoicePageState {
  const total = voices.length;
  const pages = Math.max(1, Math.ceil(total / CLOUD_VOICE_PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  const start = (current - 1) * CLOUD_VOICE_PAGE_SIZE;
  const selectedIndex = voices.findIndex((v) => v.id === selectedId);
  return {
    items: voices.slice(start, start + CLOUD_VOICE_PAGE_SIZE),
    page: current,
    pages,
    selectedPage: selectedIndex < 0 ? 0 : Math.floor(selectedIndex / CLOUD_VOICE_PAGE_SIZE) + 1,
    total,
  };
}

/** 清单收起后各块是否显示：收起只影响渲染，不发请求、不改选中。 */
export interface CloudListChrome {
  /** 列表标题、条目与空态。 */
  showList: boolean;
  /** 列表下方的「收起清单」按钮。 */
  showCollapse: boolean;
  /** 收起后的摘要行（当前音色 + 展开清单）。 */
  showSummary: boolean;
  /** 翻页条。 */
  showPager: boolean;
}

/** 清单为空时不允许收起，否则空态会被藏起来、也没地方展开。 */
export function cloudListChrome(collapsed: boolean, total: number, pages: number): CloudListChrome {
  const folded = collapsed && total > 0;
  return {
    showList: !folded,
    showCollapse: total > 0 && !folded,
    showSummary: folded,
    showPager: !folded && pages > 1,
  };
}

/** 摘要里显示的当前音色：优先显示名，其次 id；没选时返回空串。 */
export function cloudVoiceLabel(voices: ReadonlyArray<CloudVoice>, selectedId: string): string {
  const voice = voices.find((item) => item.id === selectedId);
  return voice ? (voice.name || voice.id) : selectedId.trim();
}

/** 只有「没有列音色能力」的厂商才显示手填入口（判断来自厂商档案，不写死厂商名）。 */
export function showManualVoiceEntry(canListVoices: boolean): boolean {
  return !canListVoices;
}

/** 手填入口的「保存云端音色」：id 为空或正在保存时禁用。 */
export function cloudManualSaveDisabled(idInput: string, saving = false): boolean {
  return saving || !idInput.trim();
}
