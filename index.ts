/**
 * pi-tree-workflow — /marker, /branch, /end
 *
 * /marker → set checkpoint
 * /branch → jump to fresh context from marker (sub-branch)
 * /end    → pick summary style interactively, compress back to marker
 *
 * Same-branch flow: /marker → work → /end
 * Branch flow:      /marker → /branch → work → /end
 *
 * Usage:
 *   pi -e ./index.ts
 *   # or install:
 *   pi install /path/to/pi-tree-workflow
 *
 * State model (supergsd-style): state lives entirely in branch entries.
 * No module-level caching — every handler reads state on demand.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────

const STATE_ENTRY = "tree-workflow-state";
const MARKER_LABEL = "marker";
const END_WIDGET = "tree-workflow-end";
const STATUS_KEY = "tree-workflow";

const END_PROMPTS = [
	{
		label: "默认压缩",
		prompt: [
			"Treat this as a finished work increment that should become durable context for continuing the same repository session.",
			"Focus on the final accepted outcome, not dead ends or step-by-step implementation noise.",
			"Capture the concrete code or repo changes, key decisions, important constraints, and any follow-up that still matters.",
			"Mention relevant files, commands, commits, PR outcomes, or review feedback only when they change future work.",
			"Omit temporary debugging details, abandoned attempts, and incidental churn that no longer matters.",
			"Write the summary so a future agent can continue from the repo familiarization and planning context plus this completed increment.",
		].join("\n"),
	},
	{
		label: "仅结论",
		prompt: [
			"This summary should capture ONLY the final outcome — what changed, what was decided.",
			"Omit all intermediate steps, attempts, debugging, discussion, and reasoning.",
			"Format: one paragraph of final result.",
		].join("\n"),
	},
	{
		label: "详细记录",
		prompt: [
			"Write a thorough summary that preserves enough detail for someone who needs to retrace this work.",
			"Include implementation steps, notable intermediate states, rejected approaches and why they failed, and final decisions with rationale.",
			"Still omit truly irrelevant churn (typos, trivial build fixes), but keep technical exploration steps.",
		].join("\n"),
	},
	{
		label: "代码变更",
		prompt: [
			"Focus this summary on concrete code changes: files modified, APIs added/changed/removed, new types, test coverage, and migration notes.",
			"Omit discussion, reasoning, dead ends, and non-code decisions.",
			"List changed files with a brief description of each change.",
		].join("\n"),
	},
	{
		label: "决策记录",
		prompt: [
			"Focus this summary on architecture decisions, technology choices, tradeoffs considered, and constraints discovered.",
			"Capture each decision with: context, options considered, chosen approach, and rationale.",
			"Omit implementation steps, code details, and debugging history.",
		].join("\n"),
	},
];

// ── Types ─────────────────────────────────────────────────────────

interface WorkflowState {
	version: 1;
	markerId: string;
	branched?: boolean;
}

// ── State (supergsd-style: on-demand from branch) ────────────────

function isState(value: unknown): value is WorkflowState {
	if (typeof value !== "object" || value === null) return false;
	const c = value as { version?: unknown; markerId?: unknown };
	return c.version === 1 && typeof c.markerId === "string";
}

/** Scan branch leaf→root for the latest state entry. */
function readState(ctx: ExtensionContext): WorkflowState | undefined {
	let state: WorkflowState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (isState(entry.data)) state = entry.data;
	}
	return state;
}

/** Walk up from current leaf to find the first semantic (non-custom, non-label) entry. */
function getSemanticLeafId(ctx: ExtensionContext): string | undefined {
	let id = ctx.sessionManager.getLeafId();
	while (id) {
		const entry = ctx.sessionManager.getEntry(id);
		if (!entry) return undefined;
		if (entry.type === "custom" || entry.type === "label") {
			id = entry.parentId;
			continue;
		}
		return id;
	}
	return undefined;
}

// ── Branch utilities (from supergsd) ────────────────────────────

interface SessionLike {
	getLeafId(): string | null;
	getBranch(): SessionEntry[];
}

function findPreConversationEntry(session: SessionLike): SessionEntry | null {
	if (!session.getLeafId()) return null;
	for (const entry of session.getBranch()) {
		if (
			entry.type === "message" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary" ||
			entry.type === "custom_message"
		) {
			return entry;
		}
	}
	return null;
}

function findFreshTargetId(session: SessionLike): string | null {
	const branch = session.getBranch();
	if (branch.length === 0) return null;
	const firstVisible = findPreConversationEntry(session);
	if (firstVisible) return firstVisible.parentId ?? firstVisible.id;
	return branch[0].parentId ?? branch[0].id;
}

// ── Status (reads state on-demand) ──────────────────────────────

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const state = readState(ctx);
	if (!state) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const current = getSemanticLeafId(ctx);
	const dim = (s: string) => ctx.ui.theme.fg("dim", s);

	if (current === state.markerId) {
		ctx.ui.setStatus(STATUS_KEY, dim("◎ marker"));
	} else if (state.branched) {
		ctx.ui.setStatus(STATUS_KEY, dim("↳ branch"));
	} else {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

// ── Label + state writer (shared by /marker and /end) ───────────

function applyMarker(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	nextId: string,
	msg: string,
): void {
	const prevState = readState(ctx);
	const prevMarkerId = prevState?.markerId;

	if (
		prevMarkerId &&
		prevMarkerId !== nextId &&
		ctx.sessionManager.getLabel(prevMarkerId) === MARKER_LABEL
	) {
		pi.setLabel(prevMarkerId, undefined);
	}

	let note = "";
	const existing = ctx.sessionManager.getLabel(nextId);
	if (existing === undefined || existing === MARKER_LABEL) {
		pi.setLabel(nextId, MARKER_LABEL);
	} else {
		note = ` Existing label "${existing}" kept.`;
	}

	pi.appendEntry(STATE_ENTRY, {
		version: 1,
		markerId: nextId,
		branched: false,
	} satisfies WorkflowState);

	ctx.ui.notify(`${msg}${note}`, "info");
	updateStatus(ctx);
}

// ── End prompt selection ─────────────────────────────────────────

/**
 * Resolve summary instructions for /end.
 *
 * - args is non-empty → use as custom instructions
 * - TUI mode → interactive picker
 * - non-TUI → use default prompt
 * Returns null if cancelled (picker dismissed).
 */
async function resolveEndInstructions(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const trimmed = args.trim();
	if (trimmed) return trimmed;

	if (!ctx.hasUI) {
		// Non‑TUI fallback: use default
		return END_PROMPTS[0].prompt;
	}

	const choice = await ctx.ui.select(
		"Summary style:",
		END_PROMPTS.map((p) => p.label),
	);
	if (!choice) return null;

	const found = END_PROMPTS.find((p) => p.label === choice);
	return found?.prompt ?? END_PROMPTS[0].prompt;
}

// ── Plugin ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// ── /marker ─────────────────────────────────────────────────

	pi.registerCommand("marker", {
		description: "Mark current conversation point as checkpoint",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const target = getSemanticLeafId(ctx);
			if (!target) {
				ctx.ui.notify("No conversation point to mark yet", "warning");
				return;
			}

			const state = readState(ctx);
			if (state?.markerId === target) {
				ctx.ui.notify("Marker already here", "info");
				return;
			}

			applyMarker(pi, ctx, target, "Marker set");
		},
	});

	// ── /branch ─────────────────────────────────────────────────

	pi.registerCommand("branch", {
		description:
			"Jump to fresh context from current marker (use /end to return)",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const state = readState(ctx);
			if (!state) {
				ctx.ui.notify("No marker set. Run /marker first", "warning");
				return;
			}

			const markerId = state.markerId;
			if (!ctx.sessionManager.getEntry(markerId)) {
				ctx.ui.notify(
					"Stored marker no longer exists. Run /marker again",
					"warning",
				);
				return;
			}

			const fresh = findFreshTargetId(ctx.sessionManager);
			if (!fresh) {
				ctx.ui.notify("No fresh context point found", "warning");
				return;
			}

			const result = await ctx.navigateTree(fresh, { summarize: false });
			if (result.cancelled) return;

			// Write branched state + label at the fresh position
			pi.appendEntry(STATE_ENTRY, {
				version: 1,
				markerId,
				branched: true,
			} satisfies WorkflowState);
			pi.setLabel(fresh, "branch");

			ctx.ui.notify("Branch started. Use /end to return to marker.", "info");
			updateStatus(ctx);
		},
	});

	// ── /end ────────────────────────────────────────────────────

	pi.registerCommand("end", {
		description:
			"Summarize work since marker and advance the checkpoint",
		handler: async (args, ctx) => {
			const clearFeedback = () => {
				if (ctx.hasUI) ctx.ui.setWidget(END_WIDGET, undefined);
				ctx.ui.setWorkingMessage();
			};

			await ctx.waitForIdle();

			const state = readState(ctx);
			if (!state) {
				ctx.ui.notify("No marker set. Run /marker first", "warning");
				return;
			}

			const markerId = state.markerId;
			if (!ctx.sessionManager.getEntry(markerId)) {
				ctx.ui.notify(
					"Stored marker no longer exists. Run /marker again",
					"warning",
				);
				return;
			}

			const current = getSemanticLeafId(ctx);
			if (current === markerId) {
				ctx.ui.notify("Nothing new since marker", "info");
				return;
			}

			// Resolve summary instructions
			const instructions = await resolveEndInstructions(args, ctx);
			if (instructions === null) {
				// User cancelled the picker
				return;
			}

			ctx.ui.setWorkingMessage(
				ctx.ui.theme.fg("dim", "Summarizing increment…"),
			);
			if (ctx.hasUI) {
				ctx.ui.setWidget(
					END_WIDGET,
					[ctx.ui.theme.fg("dim", "Summarizing back to marker…")],
					{ placement: "aboveEditor" },
				);
			}

			let result: Awaited<ReturnType<typeof ctx.navigateTree>>;
			try {
				result = await ctx.navigateTree(markerId, {
					summarize: true,
					customInstructions: instructions,
					replaceInstructions: false,
				});
			} finally {
				clearFeedback();
			}

			if (result.cancelled) {
				ctx.ui.notify("/end cancelled", "warning");
				return;
			}

			const next = getSemanticLeafId(ctx);
			if (!next) {
				ctx.ui.notify(
					"/end completed but no new marker point found",
					"warning",
				);
				return;
			}

			applyMarker(pi, ctx, next, "Increment summarized and marker advanced");
		},
	});
}