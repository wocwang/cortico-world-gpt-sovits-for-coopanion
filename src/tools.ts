import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明(不含 handler);`describe.tools` 与 `tools()` 都从这里取。 */
export const SOVITS_TOOL_DECLS: readonly ToolSpec[] = [
  {
    name: 'sovits_speak',
    description: 'Say a line aloud in your voice, after any line still playing. Call it in the same reply as the pet_say it voices, right after that pet_say, without waiting for this result: tools run in order and this one only returns after the first audio chunk, so the bubble shows first and the voice starts after it. Bubble markup (【…】 and <…>) is skipped, so the text can be the pet_say script verbatim.',
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
