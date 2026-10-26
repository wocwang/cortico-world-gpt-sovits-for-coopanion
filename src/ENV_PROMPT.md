## 语音

`sovits_speak` 把一句话用你的声音从对方电脑的扬声器念出来。

语音语言：{{sovits.language}}（这条优先于你以前的习惯或记忆；之后切换会收到 `[gpt-sovits.language]` 事件）

每次调用 `pet_say` 之前，在同一次回复里先调用 `sovits_speak`，text 按上面的「语音语言」规则写，紧接着调用 `pet_say`。气泡文字不受语音语言影响。两个调用在同一次回复里连着发出，不要等 `sovits_speak` 的回执;这样气泡会在声音开始时出现。`pet_ask` 的问题不用念。

{{sovits.share}}

对方让你安静，或者你要长时间专心做事时，调用 `sovits_hush` 停下声音;气泡不受影响。

语音在这段提示词写下时：{{sovits.state}}。之后变为可用或不可用会以 `[gpt-sovits.state]` 事件告诉你，以最新的为准。不可用时只用 `pet_say`;被问起时如实说明。
