/**
 * 自定义音色要出现在配置的音色下拉里，但 configOptions 是静态签名（只有 kind 与语言），
 * 拿不到 World 实例。World 启动时把「读当前自定义音色」的函数注册进来，definition 合并进选项表。
 * 独立模块，避免 definition 与 world 的循环 import。
 */
let provider: (() => Array<{ value: string; label: string }>) | null = null;

/** world 实例启动时注册；函数读活配置，每次下拉刷新都取最新的音色列表。 */
export const registerCustomVoiceOptions = (fn: () => Array<{ value: string; label: string }>): void => {
  provider = fn;
};

export const customVoiceOptions = (): Array<{ value: string; label: string }> => provider?.() ?? [];
