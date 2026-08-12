/**
 * pi-tree-workflow — /marker
 *
 * Single-command marker workflow with TUI management.
 *
 * /marker <name>  →  set named marker at current position
 * /marker         →  open marker manager TUI (list, jump, summarize, delete)
 *
 * State model: markers are stored as MARKER_ENTRY custom entries.
 * No STATE_ENTRY, no module-level caching—every handler reads state on demand.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Constants ─────────────────────────────────────────────────────

const MARKER_ENTRY = "tree-workflow-marker";
const STATUS_KEY = "tree-workflow";
const END_WIDGET = "tree-workflow-summarize";

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

const ACTION_SET = "+ Set new marker here";
const ACTION_JUMP = "Jump";
const ACTION_SUMMARIZE = "Summarize & Jump";
const ACTION_DELETE = "Delete";
const ACTION_BACK = "← Back";
const SEPARATOR = "──────────────";

// ── Types ─────────────────────────────────────────────────────────

interface MarkerData {
	name: string;
	targetId: string;
}

interface PromptsStore {
	custom: Record<string, string>;
}

// ── Marker utilities ────────────────────────────────────────────

/** Read all active markers, in creation order (per name). */
function readMarkers(ctx: ExtensionContext): MarkerData[] {
	// Scan ALL entries, not just the current branch path: markers are
	// bookmarks and must survive branch switches (jump/summarize moves
	// the leaf, abandoning the entries that held the marker).
	const byName = new Map<string, MarkerData & { deleted: boolean; ts: number }>();

	for (const e of ctx.sessionManager.getEntries()) {
		if (e.type !== "custom" || e.customType !== MARKER_ENTRY) continue;
		const d = e.data as { name?: unknown; targetId?: unknown; deleted?: boolean };
		if (typeof d.name !== "string" || typeof d.targetId !== "string") continue;

		const ts = Date.parse(e.timestamp);
		const prev = byName.get(d.name);
		// Latest entry per name wins — a later tombstone shadows the marker.
		if (prev && ts < prev.ts) continue;
		byName.set(d.name, {
			name: d.name,
			targetId: d.targetId,
			deleted: !!d.deleted,
			ts,
		});
	}

	return [...byName.values()]
		.filter((m) => !m.deleted)
		.map(({ name, targetId }) => ({ name, targetId }));
}

/** Compute the next available name when `base` already exists. */
function dedupName(base: string, existing: MarkerData[]): string {
	// ponytail: sanitization is minimal — marker names are internal, not user-facing URLs
	const clean = base.trim().replace(/[^a-zA-Z0-9\-_]/g, "-");
	if (!clean) return `marker-${Date.now()}`;

	const taken = new Set(existing.map((m) => m.name));
	if (!taken.has(clean)) return clean;
	let n = 2;
	while (taken.has(`${clean}-${n}`)) n++;
	return `${clean}-${n}`;
}

// ── Status ──────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const markers = readMarkers(ctx);
	const n = markers.length;
	if (n === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const dim = (s: string) => ctx.ui.theme.fg("dim", s);
	ctx.ui.setStatus(STATUS_KEY, dim(`${n} ${n === 1 ? "marker" : "markers"}`));
}

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
	mkdirSync(dir, { recursive: true }); // idempotent with recursive: true
	writeFileSync(PROMPTS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

const ACTION_CREATE = "+ Create prompt";
const ACTION_PROMPT_DELETE = "- Delete prompt";

async function resolveEndInstructions(
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	if (!ctx.hasUI) return DEFAULT_PROMPT;

	const store = loadPrompts();
	const customNames = Object.keys(store.custom);

	while (true) {
		const items: string[] = ["Default"];
		if (customNames.length > 0) items.push(...customNames);
		if (customNames.length > 0) items.push(SEPARATOR);
		items.push(ACTION_CREATE);
		if (customNames.length > 0) items.push(ACTION_PROMPT_DELETE);

		const choice = await ctx.ui.select("Summary style:", items);
		if (!choice) return null;

		if (choice === "Default") return DEFAULT_PROMPT;
		if (store.custom[choice]) return store.custom[choice];

		if (choice === ACTION_CREATE) {
			const name = await ctx.ui.input("Prompt name:", "");
			if (!name) continue;

			const content = await ctx.ui.editor(`Write prompt "${name}":`, "");
			if (!content) continue;

			store.custom[name] = content;
			savePrompts(store);
			customNames.push(name);
			ctx.ui.notify(`Prompt "${name}" saved`, "info");
			continue;
		}

		if (choice === ACTION_PROMPT_DELETE) {
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
			continue;
		}
	}
}

// ── Widget helper ──────────────────────────────────────────────

/** Run `fn` with a widget shown, cleaning up in `finally`. */
async function withWidget<T>(
	ctx: ExtensionCommandContext,
	widgetId: string,
	message: string,
	fn: () => Promise<T>,
): Promise<T> {
	ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", message));
	if (ctx.hasUI) {
		ctx.ui.setWidget(
			widgetId,
			[ctx.ui.theme.fg("dim", message)],
			{ placement: "aboveEditor" },
		);
	}
	try {
		return await fn();
	} finally {
		if (ctx.hasUI) ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage();
	}
}

// ── Semantic ID ─────────────────────────────────────────────────

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

// ── TUI: marker management ─────────────────────────────────────

async function markerTUI(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const markers = readMarkers(ctx);
	const names = markers.map((m) => m.name);

	// ── Level 1: pick a marker or create one ────────────────────
	const items: string[] = [...names];
	if (names.length > 0) items.push(SEPARATOR);
	items.push(ACTION_SET);

	const picked = await ctx.ui.select("Markers:", items);
	if (!picked) return; // cancelled

	// ── Quick create ────────────────────────────────────────────
	if (picked === ACTION_SET) {
		const name = await ctx.ui.input("Marker name:", "");
		if (!name) return;
		await createMarker(pi, ctx, name);
		return;
	}

	const marker = markers.find((m) => m.name === picked);
	if (!marker) {
		ctx.ui.notify(`"${picked}" no longer exists`, "warning");
		return;
	}

	// ── Level 2: action on selected marker ──────────────────────
	const actions: string[] = [ACTION_JUMP, ACTION_SUMMARIZE, ACTION_DELETE];
	actions.push(SEPARATOR, ACTION_BACK);

	const action = await ctx.ui.select(picked, actions);
	if (!action || action === ACTION_BACK) return;

	if (action === ACTION_JUMP) {
		await jumpToMarker(ctx, marker);
		return;
	}

	if (action === ACTION_DELETE) {
		await deleteMarker(pi, ctx, marker);
		updateStatus(ctx);
		return;
	}

	if (action === ACTION_SUMMARIZE) {
		await summarizeToMarker(ctx, marker);
		return;
	}
}

async function createMarker(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	name: string,
): Promise<void> {
	const target = getSemanticLeafId(ctx);
	if (!target) {
		ctx.ui.notify("No conversation point to mark", "warning");
		return;
	}

	const existing = readMarkers(ctx);
	const finalName = dedupName(name, existing);

	pi.setLabel(target, finalName);
	pi.appendEntry(MARKER_ENTRY, { name: finalName, targetId: target } satisfies MarkerData);
	ctx.ui.notify(`"${finalName}" set`, "info");
	updateStatus(ctx);
}

async function jumpToMarker(
	ctx: ExtensionCommandContext,
	marker: MarkerData,
): Promise<void> {
	if (!ctx.sessionManager.getEntry(marker.targetId)) {
		ctx.ui.notify(`"${marker.name}" no longer exists`, "warning");
		return;
	}

	const result = await ctx.navigateTree(marker.targetId, { summarize: false });
	if (result.cancelled) return;
	ctx.ui.notify(`Jumped to "${marker.name}"`, "info");
}

async function summarizeToMarker(
	ctx: ExtensionCommandContext,
	marker: MarkerData,
): Promise<void> {
	if (!ctx.sessionManager.getEntry(marker.targetId)) {
		ctx.ui.notify(`"${marker.name}" no longer exists`, "warning");
		return;
	}

	const instructions = await resolveEndInstructions(ctx);
	if (instructions === null) return;

	const current = getSemanticLeafId(ctx);
	if (current === marker.targetId) {
		ctx.ui.notify("Nothing new since this marker", "info");
		return;
	}

	const result = await withWidget(ctx, END_WIDGET, `Summarizing back to "${marker.name}"…`, async () => {
		return await ctx.navigateTree(marker.targetId, {
			summarize: true,
			customInstructions: instructions,
			replaceInstructions: true,
		});
	});

	if (result.cancelled) {
		ctx.ui.notify("Summarize cancelled", "warning");
		return;
	}

	ctx.ui.notify(`Summarized back to "${marker.name}"`, "info");
	updateStatus(ctx);
}

async function deleteMarker(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	marker: MarkerData,
): Promise<void> {
	pi.setLabel(marker.targetId, undefined);
	// Append tombstone to shadow the original entry
	pi.appendEntry(MARKER_ENTRY, {
		name: marker.name,
		targetId: marker.targetId,
		deleted: true,
	});
	ctx.ui.notify(`"${marker.name}" deleted`, "info");
}

// ── Plugin ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// ── /marker ─────────────────────────────────────────────────

	pi.registerCommand("marker", {
		description: "Set named marker or open marker manager TUI",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const name = args.trim();
			return name ? createMarker(pi, ctx, name) : markerTUI(pi, ctx);
		},
	});
}