import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明(不含 handler);`describe.tools` 与 `tools()` 都从这里取。 */
export const SOVITS_TOOL_DECLS: readonly ToolSpec[] = [
  {
    name: 'sovits_speak',
    description: 'Say a line aloud in your voice, after any line still playing. Emit it in the same reply as the pet_say it voices, immediately followed by that pet_say, without waiting for this result: tools run in order, so the bubble appears as the voice begins. Bubble markup (【…】 and <…>) is skipped, so the text can be the pet_say script verbatim. The result echoes what was actually synthesized as Said: "…" — compare the bubble against it rather than assuming they matched; under English/Japanese/Korean that text is the translation and is expected to differ. If the text starts with 【唱】 (also [唱] or [sing]), the rest is treated as a lyric line and sung in your voice by the DiffSinger singing plugin instead of being spoken; if that plugin is missing or not ready the line is simply spoken, so it is always safe to try. A sung line is also handed back as an audio attachment (with silent: true, or when lines are handed to other plugins), so a QQ voice message can send the same song. On QQ: to send a voice bar through the QQ Bot plugin, call this with silent: true first and pass the [blob …] handle from the result to qqbot_send_message\u0027s voice; through the old QQ plugin (qq_send), do not call this tool at all — pass voice=true there instead. Reply with the tool of the plugin that delivered the message: an address like c2c:<openid> (letters) belongs to qqbot_send_message, while private:<digits> belongs to qq_send — never pass one plugin\u0027s address to the other.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 2000, description: 'The line to say.' },
        silent: { type: 'boolean', description: 'true synthesizes the line without playing it on this computer: use it for a line meant for another channel (a QQ voice bar sent through qqbot_send_message, for example) that should not be heard here. The result still carries the [blob …] audio handle for that send tool.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'sovits_hush',
    description: 'Stop the voice now: the line playing is cut and queued lines are dropped. Bubbles are not affected.',
    tags: ['speak'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
