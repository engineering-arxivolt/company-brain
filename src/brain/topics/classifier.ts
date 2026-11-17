/**
 * Topic classifier maps a user's topic string to a category, image style,
 * and placement hint for LaTeX template rendering.
 * Pure string-matching — no ML, fully deterministic.
 */
export type TopicClassification = {
	category: "finance" | "comic" | "sell-off" | "general"
	style: "chart" | "panel" | "illustration"
	placement: "top" | "bottom" | "left-column" | "right-column" | "grid-1" | "grid-2" | "grid-3" | "grid-4"
}

const FINANCE_KEYWORDS = [
	"finance", "stock", "market", "sell off", "equity", "trend", "chart", "investment", "portfolio", "asset"
]
const COMIC_KEYWORDS = [
	"comic", "strip", "panel", "cartoon", "drawing", "illustration", "character", "scene"
]
const SELL_OFF_KEYWORDS = [
	"sell off", "market crash", "drop", "plunge", "declin", "downtrend", "bear market"
]

/** Classify a topic string into a category, style, and placement hint. */
export function classifyTopic(topic: string): TopicClassification {
	const lower = topic.toLowerCase()

	// Check sell-off first (most specific)
	if (SELL_OFF_KEYWORDS.some(k => lower.includes(k))) {
		return {
			category: "sell-off",
			style: "chart",
			placement: "top"
		}
	}

	// Check finance
	if (FINANCE_KEYWORDS.some(k => lower.includes(k))) {
		return {
			category: "finance",
			style: "chart",
			placement: "left-column"
		}
	}

	// Check comic
	if (COMIC_KEYWORDS.some(k => lower.includes(k))) {
		return {
			category: "comic",
			style: "panel",
			placement: "grid-1"
		}
	}

	// Default
	return {
		category: "general",
		style: "illustration",
		placement: "top"
	}
}
