/**
 * Grammar for the briefs the model writes — the fleet AI insight and the
 * per-vehicle brief (operator, 2026-10-15: "the model should validate its
 * grammar and ensure sentences follow the correct grammatical text").
 *
 * Two halves, because a prompt is a request and not a guarantee:
 *
 *   · GRAMMAR_RULES is appended to both system prompts. It asks the model to
 *     proofread its own `msg` before replying, and says what to look for.
 *   · tidyProse() runs on every brief that reaches an operator, the model's
 *     and the facts-only fallback alike. It fixes only what is MECHANICAL —
 *     spacing, punctuation, sentence capitals, the final full stop — and never
 *     touches a word or a figure, so it cannot invent anything or undo the
 *     fabrication guards that run beside it.
 */

export const GRAMMAR_RULES = `

==================================================
GRAMMAR AND PROOFREADING
========================

The brief is read by a fleet manager and must be correct, natural English.

Before replying, proofread msg sentence by sentence and correct every error you find:

* Every sentence is complete, with a subject and a main verb, starts with a capital letter and ends with a full stop.
* Subject and verb agree ("2 units are", "1 unit is"; "the fleet is").
* Nouns agree with their figure: "1 unit", "2 units", "1 fuel issue", "3 fuel issues", "1 alert", "4 alerts".
* Use "a" before a consonant sound and "an" before a vowel sound ("an overspeeding alert", "a unit").
* Keep one tense per event, consistent with the present time: what has happened is past, what is happening is present.
* No run-on sentences and no comma splices: join two clauses with "and", "but" or "while", or split them into two sentences.
* No doubled words, no missing words, no stray spaces before punctuation.

Correcting grammar must NEVER change a figure, a time, a plate, a place name or a person's name: copy those exactly as given.
`

/** Mechanical clean-up of a brief. Words and figures pass through untouched. */
export function tidyProse(text: string): string {
  let s = String(text ?? '')
    // One space between words; no space before , ; : . ! ? or a closing bracket.
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    // A doubled comma or full stop left by an edit ("units,, and" / "today..").
    .replace(/,{2,}/g, ',')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    // A space after a sentence-ending stop or a comma when a letter follows
    // directly ("today.The", "units,and"). Letters only, so 09:12, 12.5 km and
    // "FARM#212" are never split.
    .replace(/([.!?,;])([A-Za-z])/g, (m, p: string, c: string, off: number, all: string) =>
      // Leave abbreviations such as "e.g." and initials ("J.K.") alone.
      p === '.' && /\b[A-Za-z]$/.test(all.slice(0, off)) ? m : `${p} ${c}`)
    .trim()

  // A capital at the start and after every sentence end.
  s = s.replace(/^([a-z])/, (c) => c.toUpperCase())
  // Not after a one-letter abbreviation ("e.g. three units" stays as it is).
  s = s.replace(/(\w{2,}[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())

  // A final full stop, unless it already ends a sentence.
  if (s && !/[.!?]$/.test(s)) s += '.'
  return s
}
