import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明(不含 handler);`describe.tools` 与 `tools()` 都从这里取。 */
export const SOVITS_TOOL_DECLS: readonly ToolSpec[] = [
  {
    name: 'sovits_speak',
    description: 'Say a line aloud in your voice, after any line still playing. Emit it in the same reply as the pet_say it voices, immediately followed by that pet_say, without waiting for this result: tools run in order, so the bubble appears as the voice begins. Bubble markup (【…】 and <…>) is skipped, so the text can be the pet_say script verbatim. If the text starts with 【唱】 (also [唱] or [sing]), the rest is treated as a lyric line and sung in your voice by the DiffSinger singing plugin instead of being spoken; if that plugin is missing or not ready the line is simply spoken, so it is always safe to try. A sung line is also handed back as an audio attachment (with silent: true, or when lines are handed to other plugins), so a QQ voice message can send the same song.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 2000, description: 'The line to say.' },
        silent: { type: 'boolean', description: 'true synthesizes the line without playing it on this computer: use it for a line meant for another channel (a QQ voice message, for example) that should not be heard here.' },
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
