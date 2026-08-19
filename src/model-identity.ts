/** Pure helpers for refusing model names whose target can move over time. */

const GENERIC_MOVING_ALIAS = /^(?:auto|default|latest|sonnet|opus|haiku|fable)$/i;
const SUFFIXED_LATEST = /-latest$/i;
// Anthropic kept these convenient dateless names as aliases to dated
// snapshots. 4.6+ and 5.x canonical names are stable model identifiers, so
// only the documented pre-4.6 dateless family belongs here.
const ANTHROPIC_PRE_46_DATELESS = /^claude-(?:sonnet|opus|haiku)-4-(?:0|1|5)$/i;

export function isMovingModelAlias(model: string): boolean {
  return GENERIC_MOVING_ALIAS.test(model) || SUFFIXED_LATEST.test(model) || ANTHROPIC_PRE_46_DATELESS.test(model);
}
