/**
 * Clarification-question option bank.
 *
 * The Ask card renders tappable chips only when a question carries an `options`
 * array. The model is asked to supply options itself, but model output is
 * probabilistic — so the graph also attaches options deterministically for the
 * common forks (market, level, notice, weekly hours, pipeline, function,
 * availability). Same shape as the goal-planner intake's ClarifyQuestionSchema.
 *
 * Rules are intentionally narrow: a wrong set of chips is worse than free text,
 * so each regex targets the specific fork wording rather than a broad keyword.
 */

export type ClarifyQuestion = string | { question: string; options?: string[]; multi?: boolean }

interface BankRule {
  test: RegExp
  options: string[]
  multi?: boolean
}

export const QUESTION_OPTION_BANK: BankRule[] = [
  {
    test: /\b(market|same city|remote[- ]only|relocat\w*|commut\w*)\b/i,
    options: ['Same city', 'Remote-only', 'Open to relocating'],
  },
  {
    test: /\b(lateral|step up|level you(?:'re| are)? applying)\b/i,
    options: ['Lateral', 'A step up'],
  },
  {
    test: /\bnotice period\b/i,
    options: ['Under 1 month', '1–2 months', '3+ months'],
  },
  {
    test: /\b(hours?\s+(?:per|a)\s+week|weekly hours|how much time)\b/i,
    options: ['Under 5h', '5–10h', '10–20h', '20h+'],
  },
  {
    test: /\bpipeline\b/i,
    options: ['No applications yet', 'Applications out', 'Interviews booked', 'Offer in hand'],
  },
  {
    test: /\b(different function|different industry|same function)\b/i,
    options: ['Same function, new company', 'New function', 'New industry'],
  },
  {
    test: /\b(which days|availability|free hours|weekdays?)\b/i,
    multi: true,
    options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
]

/** Attach bank options to a question that clearly asks one of the known forks. */
export function enrichQuestion(q: ClarifyQuestion): ClarifyQuestion {
  const text = typeof q === 'string' ? q : q.question
  if (typeof q !== 'string' && q.options && q.options.length > 0) return q
  const rule = QUESTION_OPTION_BANK.find((r) => r.test.test(text))
  if (!rule) return q
  const base = typeof q === 'string' ? { question: q } : q
  return { ...base, options: rule.options, ...(rule.multi ? { multi: true } : {}) }
}

export function enrichQuestions(qs: ClarifyQuestion[]): ClarifyQuestion[] {
  return (qs || []).map(enrichQuestion)
}
