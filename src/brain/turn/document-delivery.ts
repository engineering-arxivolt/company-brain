/**
 * Keeps a CV/cover-letter turn from ending with prose.
 *
 * Measured failure this exists for: given a job description, the base CV and the
 * Document Delivery playbook, a model loaded the playbook, enabled the sandbox,
 * then wrote the documents *into the chat message* — hit the output cap
 * mid-resume — and called finish_turn. Nothing was written, nothing was
 * compiled, nothing was sent, and the person got a truncated answer.
 *
 * An instruction cannot fix that reliably. A turn that has promised a document
 * is not finished until sandbox_get_artifact has reported a delivered file, so
 * finish_turn is refused (and the refusal is fed back to the model) until then.
 */
export type DocumentDeliveryGuard = {
	/** This turn must produce and deliver a file. */
	require: () => void
	required: () => boolean
	/** A file reached the conversation; `path` is what landed. */
	markDelivered: (path: string) => void
	delivered: () => boolean
	/** Why finishing is not allowed yet, or undefined when it may pass. */
	refusal: () => string | undefined
}

export const DOCUMENT_DELIVERY_REFUSAL =
	"No file has been delivered yet, so this turn cannot finish. A written answer is not the deliverable. Do this now: (1) sandbox_write_file for the .tex source, (2) sandbox_run with `latexmk -pdf -interaction=nonstopmode <file>.tex` and check it reported a PDF, (3) sandbox_get_artifact for each finished PDF. Call finish_turn only after sandbox_get_artifact returned uploaded: true."

export function createDocumentDeliveryGuard(): DocumentDeliveryGuard {
	let required = false
	let deliveredPath: string | null = null
	return {
		require: () => {
			required = true
		},
		required: () => required,
		markDelivered: (path: string) => {
			deliveredPath = path
		},
		delivered: () => deliveredPath !== null,
		refusal: () => (required && deliveredPath === null ? DOCUMENT_DELIVERY_REFUSAL : undefined),
	}
}
