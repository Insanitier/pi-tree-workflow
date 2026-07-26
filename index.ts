/**
 * pi-tree-workflow — /marker, /branch, /end
 *
 * /marker → set checkpoint
 * /branch → jump to fresh context from marker (sub-branch)
 * /end    → pick/create/delete summary prompts, compress back to marker
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
} from "@earendil-works/pi-coding-agent";

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Constants ─────────────────────────────────────────────────────

const STATE_ENTRY = "tree-workflow-state";
const MARKER_ENTRY = "tree-workflow-marker";
const MARKER_LABEL = "marker";
const END_WIDGET = "tree-workflow-end";
const STATUS_KEY = "tree-workflow";

const PROMPTS_FILE = join(homedir(), ".pi", "agent", "tree-workflow-prompts.json");

const DEFAULT_PROMPT = [
	"Report the completed work in a structured format:\n",
	"## Goal — What was this increment trying to achieve",
	"## Result — Final outcome, what was accomplished, key decisions made",
	"## Output — Concrete code/repo changes, files modified, APIs added/changed/removed",
	"## Evidence — Key test results, validation, verification evidence",
	"## Learnings — Ruled-out paths, gotchas, assumptions discovered, reusable lessons",
	"",
	"Focus on the final accepted outcome. Omit dead ends, debugging steps, intermediate attempts, and irrelevant churn.",
	"Capture only what matters for continuing the session: decisions, constraints, and actionable results.",
	"Write so a future agent can pick up from this increment without retracing the work.",
].join("\n");

const ACTION_CREATE = "+ Create prompt";
const ACTION_DELETE = "- Delete prompt";

// ── Types ─────────────────────────────────────────────────────────

interface WorkflowState {
	version: 1;
	markerId: string;
	branched?: boolean;
}

interface MarkerData {
	name: string;
	targetId: string;
}

interface PromptsStore {
	custom: Record<string, string>;
}

// ── State (supergsd-style: on-demand from branch) ────────────────

function isState(value: unknown): value is WorkflowState {
	if (typeof value !== "object" || value === null) return false;
	const c = value as { version?: unknown; markerId?: unknown };
	return c.version === 1 && typeof c.markerId === "string";
}

function readState(ctx: ExtensionContext): WorkflowState | undefined {
	let state: WorkflowState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (isState(entry.data)) state = entry.data;
	}
	return state;
}

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

// ── Marker utilities ────────────────────────────────────────────

function isMarkerEntry(
	entry: unknown,
): entry is { id: string; data: MarkerData } {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (e.type !== "custom" || e.customType !== MARKER_ENTRY) return false;
	const d = e.data as { name?: unknown; targetId?: unknown } | undefined;
	return !!d && typeof d.name === "string" && typeof d.targetId === "string";
}

function readMarkers(ctx: ExtensionContext): MarkerData[] {
	const markers: MarkerData[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (isMarkerEntry(entry)) markers.push(entry.data);
	}
	return markers;
}

function nextMarkerName(markers: MarkerData[]): string {
	let max = 0;
	for (const m of markers) {
		const match = m.name.match(/^Marker (\d+)$/);
		if (match) {
			const n = parseInt(match[1], 10);
			if (n > max) max = n;
		}
	}
	return `Marker ${max + 1}`;
}

// ── Status ──────────────────────────────────────────────────────

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

// ── Label + state writer ───────────────────────────────────────

// Track the last entry we gave the marker label so we can restore
// across sessions even when the state entry is deep in the tree.
let lastMarkerLabelTarget: string | undefined;

// ── Prompt persistence ─────────────────────────────────────────

function loadPrompts(): PromptsStore {
	try {
		const raw = readFileSync(PROMPTS_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && parsed.custom) {
			return parsed as PromptsStore;
		}
	} catch {
		// File doesn't exist or is corrupt — start fresh
	}
	return { custom: {} };
}

function savePrompts(store: PromptsStore): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(PROMPTS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ── Interactive /end picker ─────────────────────────────────────

async function resolveEndInstructions(
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	if (!ctx.hasUI) return DEFAULT_PROMPT;

	const store = loadPrompts();
	const customNames = Object.keys(store.custom);

	while (true) {
		const items: string[] = ["Default"];
		if (customNames.length > 0) items.push(...customNames);
		if (customNames.length > 0) items.push("──────────────");
		items.push(ACTION_CREATE);
		if (customNames.length > 0) items.push(ACTION_DELETE);

		const choice = await ctx.ui.select("Summary style:", items);
		if (!choice) return null; // cancelled

		// ── Built-in ──
		if (choice === "Default") return DEFAULT_PROMPT;

		// ── User's custom prompt ──
		if (store.custom[choice]) return store.custom[choice];

		// ── Create ──
		if (choice === ACTION_CREATE) {
			const name = await ctx.ui.input("Prompt name:", "");
			if (!name) continue; // cancelled or empty → back to picker

			const content = await ctx.ui.editor(
				`Write prompt "${name}":`,
				"",
			);
			if (!content) continue;

			store.custom[name] = content;
			savePrompts(store);
			customNames.push(name);
			ctx.ui.notify(`Prompt "${name}" saved`, "info");
			continue; // back to picker
		}

		// ── Delete ──
		if (choice === ACTION_DELETE) {
			if (customNames.length === 0) {
				ctx.ui.notify("No custom prompts to delete", "info");
				continue;
			}

			const toDelete = await ctx.ui.select("Choose prompt to delete:", customNames);
			if (!toDelete) continue;

			const confirmed = await ctx.ui.confirm("Confirm delete", `Delete "${toDelete}"?`);
			if (!confirmed) continue;

			delete store.custom[toDelete];
			savePrompts(store);
			customNames.splice(customNames.indexOf(toDelete), 1);
			ctx.ui.notify(`Prompt "${toDelete}" deleted`, "info");
			continue; // back to picker
		}
	}
}

// ── Plugin ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const state = readState(ctx);
		if (state) lastMarkerLabelTarget = state.markerId;
		updateStatus(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// ── /marker ─────────────────────────────────────────────────

	pi.registerCommand("marker", {
		description: "Mark current conversation point as named checkpoint",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const target = getSemanticLeafId(ctx);
			if (!target) {
				ctx.ui.notify("No conversation point to mark yet", "warning");
				return;
			}

			const markers = readMarkers(ctx);
			if (markers.some((m) => m.targetId === target)) {
				ctx.ui.notify("Marker already here", "info");
				return;
			}

			const name = nextMarkerName(markers);

			pi.setLabel(target, name);
			pi.appendEntry(MARKER_ENTRY, {
				name,
				targetId: target,
			} satisfies MarkerData);
			// State entry for /end and /branch backward compat
			pi.appendEntry(STATE_ENTRY, {
				version: 1,
				markerId: target,
				branched: false,
			} satisfies WorkflowState);
			lastMarkerLabelTarget = target;

			ctx.ui.notify(`"${name}" set`, "info");
			updateStatus(ctx);
		},
	});

	// ── /list-markers ──────────────────────────────────────────

	pi.registerCommand("list-markers", {
		description: "List all saved markers",
		handler: async (_args, ctx) => {
			const markers = readMarkers(ctx);
			if (markers.length === 0) {
				ctx.ui.notify("No markers set", "info");
				return;
			}

			const text = markers
				.map((m) => `${m.name}`)
				.join("\n");

			if (ctx.hasUI) {
				ctx.ui.editor("Markers", text);
			} else {
				ctx.ui.notify(`Markers: ${text}`, "info");
			}
		},
	});

	// ── /jump-marker ───────────────────────────────────────────

	pi.registerCommand("jump-marker", {
		description: "Jump to a marker by number",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const num = args?.trim();
			if (!num || !/^\d+$/.test(num)) {
				ctx.ui.notify("Usage: /jump-marker <n>", "warning");
				return;
			}

			const markers = readMarkers(ctx);
			const name = `Marker ${num}`;
			const marker = markers.find((m) => m.name === name);
			if (!marker) {
				ctx.ui.notify(`"${name}" not found`, "warning");
				return;
			}

			if (!ctx.sessionManager.getEntry(marker.targetId)) {
				ctx.ui.notify(`"${name}" target no longer exists`, "warning");
				return;
			}

			const result = await ctx.navigateTree(marker.targetId, {
				summarize: false,
			});
			if (result.cancelled) return;

			ctx.ui.notify(`Jumped to "${name}"`, "info");
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

			const branchEntries = ctx.sessionManager.getBranch();
			const fresh = branchEntries.length > 0
				? (branchEntries[0].parentId ?? branchEntries[0].id)
				: undefined;
			if (!fresh) {
				ctx.ui.notify("No fresh context point found", "warning");
				return;
			}

			const result = await ctx.navigateTree(fresh, { summarize: false });
			if (result.cancelled) return;

			pi.appendEntry(STATE_ENTRY, {
				version: 1,
				markerId,
				branched: true,
			} satisfies WorkflowState);

			ctx.ui.notify("Branch started. Use /end to return to marker.", "info");
			updateStatus(ctx);
		},
	});

	// ── /end ────────────────────────────────────────────────────

	pi.registerCommand("end", {
		description:
			"Summarize work since marker and advance the checkpoint",
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

			const current = getSemanticLeafId(ctx);
			if (current === markerId) {
				ctx.ui.notify("Nothing new since marker", "info");
				return;
			}

			const instructions = await resolveEndInstructions(ctx);
			if (instructions === null) return;

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
					replaceInstructions: true,
				});
			} finally {
				if (ctx.hasUI) ctx.ui.setWidget(END_WIDGET, undefined);
				ctx.ui.setWorkingMessage();
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

			// Set marker at destination (no named entry — avoids clutter)
			pi.setLabel(next, MARKER_LABEL);
			pi.appendEntry(STATE_ENTRY, {
				version: 1,
				markerId: next,
				branched: false,
			} satisfies WorkflowState);
			lastMarkerLabelTarget = next;

			ctx.ui.notify("Increment summarized, marker advanced", "info");
			updateStatus(ctx);
		},
	});
}