export const EMPTY_BRIEF = { subject: null, audience: null, key_message: null, duration_seconds: null, format: null }
const text = (value) => value.trim().replace(/[.,;!?\s]+$/, '').trim()
const gcd = (a, b) => b ? gcd(b, a % b) : a

export function mergeBrief(brief, update = {}) {
  const next = { ...EMPTY_BRIEF, ...brief }
  for (const field of Object.keys(EMPTY_BRIEF)) {
    const value = update[field]
    if (field === 'duration_seconds') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1800) next[field] = value
    } else if (typeof value === 'string' && value.trim()) {
      next[field] = field === 'audience' ? text(value).toLowerCase() : text(value)
    }
  }
  return next
}

/** Conversation state is independent of the executor's disposable composition. */
export function beginGoalTurn(previous, prompt, composition) {
  const promotional = /\b(promo(?:tional)?|advert(?:isement|ising)?|commercial)\b/i.test(prompt)
  const creation = /\b(create|build|produce|start|make (?:a|an|another|new))\b/i.test(prompt)
  const explicitlyNew = /\b(new|another|different)\s+(?:(?:short|promotional|promo)\s+)*(?:goal|video|promo|advertisement|commercial)\b|\bstart (?:over|again)\b/i.test(prompt)
  const goal = !previous || explicitlyNew || (creation && /\b(video|promo|advertisement|commercial)\b/i.test(prompt) && !/\b(actually|instead|correction)\b/i.test(prompt))
    ? { goal_id: crypto.randomUUID(), goal_kind: promotional ? 'promotional_video' : null, brief: { ...EMPTY_BRIEF }, pending_clarification: null }
    : { ...previous, brief: { ...previous.brief } }
  const update = {}
  const duration = prompt.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/i)
  if (duration) update.duration_seconds = Number(duration[1]) * (/^min/i.test(duration[2]) ? 60 : 1)
  const labels = { subject: /(?:subject|product)\s*(?:is|:|=|to)\s*(.+)/i, audience: /(?:audience|target audience)\s*(?:is|:|=|to)\s*(.+)/i,
    key_message: /(?:key message|main message|message)\s*(?:is|:|=|to)\s*(.+)/i, format: /\bformat\s*(?:is|:|=|to)\s*(.+)/i }
  for (const [field, pattern] of Object.entries(labels)) {
    const match = prompt.match(pattern)
    if (match) update[field] = match[1]
  }
  const field = goal.pending_clarification?.field
  // A short answer belongs to the pending field. A duration-only correction must
  // not accidentally become the answer to a pending audience/message question.
  const remainder = text(prompt.replace(duration?.[0] || /$^/, '').replace(/[,;]+\s*$/, ''))
  const isCorrection = /^(actually|instead|change|update|make|set|keep|use|it should|the duration)\b/i.test(prompt)
  if (field && field !== 'duration_seconds' && !Object.keys(labels).some((key) => update[key]) && !isCorrection && remainder) update[field] = remainder
  goal.brief = mergeBrief(goal.brief, update)
  if (goal.goal_kind === 'promotional_video') {
    goal.brief.duration_seconds ??= 30
    const width = composition.width || 1280, height = composition.height || 720
    const divisor = gcd(width, height)
    goal.brief.format ??= `${width / divisor}:${height / divisor}`
  }
  return goal
}

export function receiveGoalPlan(goal, plan) {
  return { ...goal, goal_id: plan.goal_id || goal.goal_id, goal_kind: plan.goal_kind ?? goal.goal_kind,
    scene_plan_approved: plan.scene_plan_approved ?? goal.scene_plan_approved ?? false,
    brief: mergeBrief(plan.new_goal ? EMPTY_BRIEF : goal.brief, plan.brief),
    pending_clarification: plan.status === 'clarify' ? plan.pending_clarification || { question: plan.message } : null }
}
