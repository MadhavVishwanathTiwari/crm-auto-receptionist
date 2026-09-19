// Shared class strings for the screens that have not been converted to
// components/ui yet.
//
// This file used to be the whole design system. It is now a compatibility
// shim: each constant is the new component's class string, so a screen still
// writing `className={BUTTON}` gets the new button without being touched, and
// the tone maps keep their old Record<string, string> shape on top of the one
// real table in lib/ui/tones.ts.
//
// Nothing new should import from here. It goes away when the last screen does.

import { buttonClasses } from "@/components/ui/Button";
import { inputClasses } from "@/components/ui/Input";
import {
  OUTCOME_TONE as OUTCOME_TONES,
  STAGE_TONE as STAGE_TONES,
  STATUS_TONE as STATUS_TONES,
  TONE_TEXT,
  type Tone,
} from "@/lib/ui/tones";

export const BUTTON = buttonClasses("secondary", "md");
export const BUTTON_QUIET = buttonClasses("ghost", "sm");
export const INPUT = inputClasses();

export const PANEL = "rounded-lg border border-line bg-surface p-4";

/** Every page is a full-height column whose body owns its own scrolling. */
export const PAGE = "flex h-full flex-col overflow-hidden";

export const PAGE_HEADER =
  "flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5";

function asClasses(map: Record<string, Tone>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([key, tone]) => [key, TONE_TEXT[tone]]),
  );
}

export const STATUS_TONE = asClasses(STATUS_TONES);
export const OUTCOME_TONE = asClasses(OUTCOME_TONES);
export const STAGE_TONE = asClasses(STAGE_TONES);
