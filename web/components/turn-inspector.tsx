import { cn } from "@lib/utils"
import { ArrowRight, Loader2, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useQueryParam } from "@lib/navigation"
import { useOrgMemberRole } from "@/hooks/use-org-member-role"
import {
	type DecisionView,
	type TurnInspection,
	useRecentDecisions,
	useTurnInspection,
} from "@/hooks/use-turn-inspection"
import { dmSans125ClassName } from "@/lib/fonts"

/**
 * The turn inspector: one turn, explained.
 *
 * Slack asks the brain for a CV and gets a picture; something decided that, and
 * until now finding out which thing meant reading compute.ts. Everything a turn
 * decided — the route, the model, the playbook JEV preloaded, every tool effect
 * — is already recorded per trace; this page is the reading of it.
 *
 * The trace id comes from anywhere: a `[company-brain][<trace>]` log line, a
 * support report, or the recent-turns list when you have none.
 */
const CARD = "rounded-[14px] bg-[#14161A] p-5"
const INPUT =
	"h-9 w-full rounded-[10px] border border-white/[0.08] bg-[#0D0F14] px-3 text-[13px] text-[#FAFAFA] outline-none placeholder:text-[#525966] focus-visible:border-white/[0.16]"

function Section({
	title,
	hint,
	children,
}: {
	title: string
	hint?: string
	children: React.ReactNode
}) {
	return (
		<section className={CARD}>
			<div className="flex items-baseline justify-between gap-3">
				<h3 className={cn(dmSans125ClassName(), "text-[13px] font-semibold text-[#FAFAFA]")}>
					{title}
				</h3>
				{hint && <span className="text-[11px] text-[#737373]">{hint}</span>}
			</div>
			<div className="mt-3">{children}</div>
		</section>
	)
}

function Chip({
	children,
	tone = "default",
}: {
	children: React.ReactNode
	tone?: "default" | "accent"
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]",
				tone === "accent"
					? "border-[#4BA0FA]/30 bg-[#4BA0FA]/10 text-[#9CCBFF]"
					: "border-white/10 text-[#9A9A9A]",
			)}
		>
			{children}
		</span>
	)
}

function Relative({ at }: { at: number | null }) {
	if (!at) return <span className="text-[#525966]">unknown</span>
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
	const label =
		seconds < 60
			? `${seconds}s ago`
			: seconds < 3_600
				? `${Math.round(seconds / 60)}m ago`
				: seconds < 86_400
					? `${Math.round(seconds / 3_600)}h ago`
					: `${Math.round(seconds / 86_400)}d ago`
	return (
		<span title={new Date(at).toISOString()} className="text-[#737373]">
			{label}
		</span>
	)
}


function DecisionRow({ decision }: { decision: DecisionView }) {
	const alternatives = Object.entries(decision.alternatives ?? {}).sort(
		(a, b) => b[1] - a[1],
	)
	return (
		<li className="flex flex-col gap-1 border-t border-white/[0.06] py-2.5 first:border-t-0 first:pt-0">
			<div className="flex flex-wrap items-center gap-2">
				<Chip tone="accent">{decision.kind}</Chip>
				<span className="text-[13px] text-[#FAFAFA]">{decision.choice}</span>
				<span className="text-[11px] text-[#737373]">on {decision.subject}</span>
				<span className="ml-auto text-[11px]">
					<Relative at={decision.createdAt} />
				</span>
			</div>
			{decision.reason && (
				<p className="text-[12px] leading-relaxed text-[#8B929E]">{decision.reason}</p>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				{typeof decision.confidence === "number" && (
					<Chip>confidence {Math.round(decision.confidence * 100)}%</Chip>
				)}
				<Chip>{decision.source}</Chip>
				{alternatives.slice(0, 4).map(([name, weight]) => (
					<Chip key={name}>
						{name} {Math.round(weight * 100)}%
					</Chip>
				))}
			</div>
		</li>
	)
}

function InspectionDetail({ inspection }: { inspection: TurnInspection }) {
	const { summary } = inspection
	if (!summary.decisionCount) {
		return (
			<div className={cn(CARD, "text-[13px] text-[#8B929E]")}>
				Nothing is recorded for{" "}
				<code className="text-[#FAFAFA]">{inspection.traceId}</code>. Either the id is
				wrong, or the turn ran before the decision log existed.
			</div>
		)
	}
	return (
		<div className="flex flex-col gap-4">
			<Section
				title="Route"
				hint={summary.route ? `flow: ${summary.route.flow}` : "not recorded"}
			>
				{summary.route ? (
					<div className="flex flex-col gap-2">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[15px] font-medium text-[#FAFAFA]">
								{summary.route.primary}
							</span>
							<span className="text-[12px] text-[#737373]">
								{summary.route.primary === "model"
									? "no deterministic route — the model answered"
									: "claimed this turn"}
							</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{summary.route.matched.length ? (
								summary.route.matched.map((route) => <Chip key={route}>{route}</Chip>)
							) : (
								<Chip>no other route considered</Chip>
							)}
						</div>
					</div>
				) : (
					<p className="text-[13px] text-[#8B929E]">
						This turn predates route recording, so only the rest of its decisions are shown.
					</p>
				)}
			</Section>

			<div className="grid gap-4 md:grid-cols-2">
				<Section title="Model">
					{summary.model ? (
						<div className="flex flex-col gap-1">
							<span className="text-[13px] text-[#FAFAFA]">{summary.model.choice}</span>
							{summary.model.reason && (
								<p className="text-[12px] text-[#8B929E]">{summary.model.reason}</p>
							)}
						</div>
					) : (
						<p className="text-[13px] text-[#8B929E]">Not recorded.</p>
					)}
				</Section>

				<Section title="Playbook" hint={summary.skill?.source}>
					{summary.skill ? (
						<div className="flex flex-col gap-1.5">
							<span className="text-[13px] text-[#FAFAFA]">{summary.skill.choice}</span>
							{summary.skill.reason && (
								<p className="text-[12px] text-[#8B929E]">{summary.skill.reason}</p>
							)}
						</div>
					) : (
						<p className="text-[13px] text-[#8B929E]">
							No playbook was preloaded — the model worked without one.
						</p>
					)}
				</Section>
			</div>

			<Section title="Tool effects" hint={`${summary.tools.length} recorded`}>
				{summary.tools.length ? (
					<ul className="flex flex-col gap-2">
						{summary.tools.map((tool, index) => (
							<li
								key={`${tool.subject}-${index}`}
								className="flex flex-wrap items-center gap-2"
							>
								<code className="text-[12px] text-[#FAFAFA]">{tool.subject}</code>
								<Chip tone="accent">{tool.choice}</Chip>
								{tool.reason && (
									<span className="text-[11px] text-[#737373]">{tool.reason}</span>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-[13px] text-[#8B929E]">No external tool was called.</p>
				)}
			</Section>

			<Section
				title="Timeline"
				hint={
					summary.durationMs
						? `${summary.decisionCount} decisions over ${(summary.durationMs / 1000).toFixed(1)}s`
						: `${summary.decisionCount} decisions`
				}
			>
				<ul className="flex flex-col">
					{inspection.decisions.map((decision, index) => (
						<DecisionRow key={`${decision.kind}-${index}`} decision={decision} />
					))}
				</ul>
			</Section>
		</div>
	)
}

function RecentTurns({ onPick }: { onPick: (traceId: string) => void }) {
	const { data, isLoading, error } = useRecentDecisions(true)
	const turns = useMemo(() => {
		const byTrace = new Map<
			string,
			{ traceId: string; newest: number; count: number; route?: string }
		>()
		for (const decision of data ?? []) {
			const entry = byTrace.get(decision.traceId) ?? {
				traceId: decision.traceId,
				newest: decision.createdAt,
				count: 0,
			}
			entry.count += 1
			entry.newest = Math.max(entry.newest, decision.createdAt)
			if (decision.kind === "turn_route") entry.route = decision.choice
			byTrace.set(decision.traceId, entry)
		}
		return [...byTrace.values()].sort((a, b) => b.newest - a.newest).slice(0, 25)
	}, [data])

	if (isLoading) {
		return (
			<p className="flex items-center gap-2 text-[13px] text-[#8B929E]">
				<Loader2 className="size-3.5 animate-spin" /> Reading the decision log…
			</p>
		)
	}
	if (error) {
		return <p className="text-[13px] text-[#E5484D]">{(error as Error).message}</p>
	}
	if (!turns.length) {
		return (
			<p className="text-[13px] text-[#8B929E]">
				No decisions recorded yet. Ask the brain something in Slack, then come back.
			</p>
		)
	}
	return (
		<ul className="flex flex-col rounded-[14px] bg-[#14161A] p-0">
			{turns.map((turn) => (
				<li key={turn.traceId} className="border-t border-white/[0.06] first:border-t-0">
					<button
						type="button"
						onClick={() => onPick(turn.traceId)}
						className="flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-white/[0.03]"
					>
						<Chip tone="accent">{turn.route ?? "turn"}</Chip>
						<code className="truncate text-[12px] text-[#FAFAFA]">{turn.traceId}</code>
						<span className="text-[11px] text-[#737373]">{turn.count} decisions</span>
						<span className="ml-auto flex items-center gap-2 text-[11px]">
							<Relative at={turn.newest} />
							<ArrowRight className="size-3.5 text-[#525966]" />
						</span>
					</button>
				</li>
			))}
		</ul>
	)
}

export function TurnInspector() {
	const { isAdmin } = useOrgMemberRole()
	const [traceParam, setTraceParam] = useQueryParam("trace")
	const [draft, setDraft] = useState(traceParam ?? "")
	const inspection = useTurnInspection(traceParam, Boolean(traceParam) && isAdmin)

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
			<div className="flex flex-col gap-1">
				<h2
					className={cn(dmSans125ClassName(), "text-[18px] font-semibold text-[#FAFAFA]")}
				>
					Turn inspector
				</h2>
				<p className="text-[13px] text-[#8B929E]">
					What one turn decided: the route that claimed it, the model that answered, the
					playbook that was preloaded, and every tool it touched.
				</p>
			</div>

			{!isAdmin ? (
				<p className={cn(CARD, "text-[13px] text-[#8B929E]")}>
					The inspector is for workspace admins: it carries the model's reasoning and the
					audit trail, not just the answer.
				</p>
			) : (
				<>
					<form
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault()
							const next = draft.trim()
							setTraceParam(next ? next : null)
						}}
					>
						<div className="relative flex-1">
							<Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#525966]" />
							<input
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								placeholder="Paste a trace id, or pick a recent turn below"
								className={cn(INPUT, "pl-8")}
							/>
						</div>
						<button
							type="submit"
							className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[#0D121A] px-4 text-[12px] font-semibold text-[#FAFAFA] shadow-[inset_1.5px_1.5px_4.5px_rgba(0,0,0,0.7)] transition-opacity hover:opacity-80"
						>
							Inspect
						</button>
					</form>

					{traceParam ? (
						<>
							<div className="flex items-center justify-between">
								<p className="text-[12px] text-[#737373]">
									Trace <code className="text-[#FAFAFA]">{traceParam}</code>
								</p>
								<button
									type="button"
									onClick={() => {
										setDraft("")
										setTraceParam(null)
									}}
									className="cursor-pointer text-[12px] text-[#737373] hover:text-[#FAFAFA]"
								>
									Back to recent turns
								</button>
							</div>
							{inspection.isLoading && (
								<p className="flex items-center gap-2 text-[13px] text-[#8B929E]">
									<Loader2 className="size-3.5 animate-spin" /> Loading this turn…
								</p>
							)}
							{inspection.error && (
								<p className="text-[13px] text-[#E5484D]">
									{(inspection.error as Error).message}
								</p>
							)}
							{inspection.data && <InspectionDetail inspection={inspection.data} />}
						</>
					) : (
						<div className="flex flex-col gap-2">
							<h3 className="text-[13px] font-medium text-[#FAFAFA]">Recent turns</h3>
							<RecentTurns
								onPick={(traceId) => {
									setDraft(traceId)
									setTraceParam(traceId)
								}}
							/>
							<p className="text-[11px] text-[#525966]">
								Trace ids also appear in log lines as{" "}
								<code>[company-brain][&lt;trace&gt;]</code>, and in any support report
								attached to a thread.{" "}
								<Link href="/configure" className="underline hover:text-[#FAFAFA]">
									Settings
								</Link>{" "}
								shows what the brain is configured to do; this page shows what it did.
							</p>
						</div>
					)}
				</>
			)}
		</div>
	)
}
