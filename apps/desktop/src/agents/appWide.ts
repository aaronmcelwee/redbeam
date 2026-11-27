/**
 * Agent calls about the app rather than about one PDF: sending a bug report
 * and reading the release notes. A PDF's workspace answers them when one is
 * open (it adds where the session was, and can draw a picture of its sheet);
 * the router answers them on the start screen, where no workspace is.
 *
 * Aaron, 2026-11-27: "Add the report problem or bug report feature as an
 * agent usable tool." The report is the one Settings › Report a bug sends:
 * the update Worker keeps it and the Reports workflow opens a GitHub issue
 * labelled "bug report".
 */
import {
  EMPTY_DRAFT, EMPTY_SUGGESTION, REPORT_KINDS, SKILLS, buildPayload, draftProblem, gatherContext, sendReport,
  type BugKind, type ReportDraft, type ReportKind, type SendResult, type SkillName,
} from '../report/report.js'
import { compareVersions, recentReleases, type Release } from '../whatsnew/changelog.js'

/** Reports already sent from this window, by session and summary: a retry is not a second issue. */
const sent = new Map<string, string>()

/** For tests: forget what was sent. */
export function forgetSentReports(): void { sent.clear() }

export interface AgentReportInput {
  params: Record<string, unknown>
  /** The AI app ("Claude"), never the session's name: that carries the client's job name. */
  app: string | null
  agentId: string | null
  /** "PDF · sheet", or '' on the start screen. */
  where: string
  /** A picture to attach, or a function that draws one; null for none. */
  picture?: (() => Promise<string | null>) | null
  send?: (payload: ReturnType<typeof buildPayload>) => Promise<SendResult>
  context?: typeof gatherContext
}

/** The draft an agent's call describes, or the reason it cannot be sent. */
export function agentDraft(params: Record<string, unknown>, app: string | null): ReportDraft | { error: string } {
  const kindIn = String(params['kind'] ?? 'broke')
  const kinds = REPORT_KINDS.map((k) => k.value)
  if (!kinds.includes(kindIn as BugKind)) return { error: `kind must be one of ${kinds.join(', ')}` }
  const said = typeof params['details'] === 'string' ? params['details'].trim() : ''
  const byline = `Reported by an AI agent${app !== null && app !== '' ? ` (${app})` : ''} through REDBEAM's agent tools.`
  const draft: ReportDraft = {
    ...EMPTY_DRAFT,
    kind: kindIn as ReportKind,
    summary: typeof params['summary'] === 'string' ? params['summary'].trim() : '',
    details: said === '' ? byline : `${said}\n\n${byline}`,
    includeWhere: params['includeWhere'] !== false,
  }
  const problem = draftProblem(draft)
  if (problem !== null) {
    return { error: draft.summary === '' ? '`summary` is required: what happened, in one sentence' : problem }
  }
  return draft
}

export async function reportForAgent(input: AgentReportInput): Promise<Record<string, unknown>> {
  const draft = agentDraft(input.params, input.app)
  if ('error' in draft) return draft
  const key = `${input.agentId ?? ''}|${draft.summary.toLowerCase()}`
  const before = sent.get(key)
  if (before !== undefined) {
    return { sent: true, id: before, duplicate: true, note: 'this session already sent this report, so it was not sent again' }
  }
  const wanted = input.params['screenshot'] === true
  if (wanted && input.picture != null) {
    try { draft.screenshot = await input.picture() } catch { draft.screenshot = null }
  }
  const ctx = await (input.context ?? gatherContext)(input.where)
  const result = await (input.send ?? sendReport)(buildPayload(draft, ctx))
  if (!result.ok) return { error: result.reason }
  sent.set(key, result.id)
  return {
    sent: true, id: result.id, kind: draft.kind,
    screenshot: draft.screenshot !== null ? 'attached' : wanted ? 'none could be drawn here; sent without one' : 'none',
    where: draft.includeWhere && input.where !== '' ? input.where : null,
    issue: 'It becomes a GitHub issue labelled "bug report" within the hour. Tell the person what you reported.',
  }
}

/**
 * A suggestion for one of the precon skills, as Settings › Suggest a skill
 * improvement sends it: the same Worker, filed as a GitHub issue labelled
 * "skill suggestion" that the daily skill sync reviews and brings to the
 * skill's owner. An agent sends one when the person corrects it on
 * something the skill should have told it, or it finds a step the skill
 * gets wrong. `summary` is what the agent should do differently;
 * `suggestion` the wording or example; `why` what happened.
 */
export function agentSuggestion(params: Record<string, unknown>, app: string | null): ReportDraft | { error: string } {
  const skillIn = String(params['skill'] ?? 'unsure')
  const skills = SKILLS.map((k) => k.value)
  if (!skills.includes(skillIn as SkillName)) return { error: `skill must be one of ${skills.join(', ')}` }
  const part = (key: string) => (typeof params[key] === 'string' ? params[key].trim() : '')
  const suggestion = part('suggestion')
  const why = part('why')
  const byline = `Suggested by an AI agent${app !== null && app !== '' ? ` (${app})` : ''} through REDBEAM's agent tools.`
  const details = [
    ...(suggestion === '' ? [] : [`Suggested wording:\n${suggestion}`]),
    ...(why === '' ? [] : [`Why:\n${why}`]),
    byline,
  ].join('\n\n')
  const draft: ReportDraft = {
    ...EMPTY_SUGGESTION,
    skill: skillIn as SkillName,
    summary: part('summary'),
    details,
    includeWhere: params['includeWhere'] !== false,
  }
  const problem = draftProblem(draft)
  if (problem !== null) {
    return { error: draft.summary === '' ? '`summary` is required: what the agent should do differently, in one sentence' : problem }
  }
  return draft
}

export async function suggestForAgent(input: AgentReportInput): Promise<Record<string, unknown>> {
  const draft = agentSuggestion(input.params, input.app)
  if ('error' in draft) return draft
  const key = `skill|${input.agentId ?? ''}|${draft.summary.toLowerCase()}`
  const before = sent.get(key)
  if (before !== undefined) {
    return { sent: true, id: before, duplicate: true, note: 'this session already sent this suggestion, so it was not sent again' }
  }
  const ctx = await (input.context ?? gatherContext)(input.where)
  const result = await (input.send ?? sendReport)(buildPayload(draft, ctx))
  if (!result.ok) return { error: result.reason }
  sent.set(key, result.id)
  return {
    sent: true, id: result.id, skill: draft.skill,
    where: draft.includeWhere && input.where !== '' ? input.where : null,
    review: 'It becomes a GitHub issue labelled "skill suggestion" within the hour. Claude reviews it with the daily skill sync and brings a proposed change to the skill\'s owner, who approves or declines it; nothing changes in the skill until then. Keep following the skill as it is, and tell the person what you suggested.',
  }
}

/** Release notes as the What's new dialog shows them. */
export function whatsNewForAgent(
  params: Record<string, unknown>, releases: readonly Release[], current: string,
): Record<string, unknown> {
  const since = typeof params['since'] === 'string' ? params['since'].trim().replace(/^v/, '') : ''
  if (since !== '' && !/^\d+\.\d+\.\d+$/.test(since)) return { error: 'since must be a version like 0.3.100' }
  const n = Math.max(1, Math.floor(Number(params['limit'] ?? 5)) || 5)
  const picked = since !== ''
    ? recentReleases(releases, current, releases.length).filter((r) => compareVersions(r.version, since) > 0)
    : recentReleases(releases, current, n)
  return {
    version: current,
    releases: picked.map((r) => ({
      version: r.version,
      date: r.date,
      notes: r.blocks.map((b) => (b.kind === 'heading' ? `## ${b.text}` : b.kind === 'item' ? `- ${b.text}` : b.text)).join('\n'),
    })),
  }
}

/** The actions answered with no PDF open. */
export const APP_WIDE_ACTIONS: ReadonlySet<string> = new Set(['report_problem', 'suggest_skill_improvement', 'whats_new'])
