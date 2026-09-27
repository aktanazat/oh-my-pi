import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";

/**
 * A reactive Fable 429 blocks the credential until the reset that error
 * reported. Anthropic can restore the tier earlier (a plan change or a
 * corrected counter), and the block then idles a usable account for days —
 * observed as `tier:fable` blocks persisting three days past a quota reset
 * while the live report read 0% used. A healthy live report must lift it, but
 * only when every limit gating that scope has headroom: the shared 5-hour wall
 * blocks Fable too, so a spent 5h window must keep the block alive.
 */
function sharedLimit(id: string, windowId: string, usedFraction: number): UsageLimit {
	return {
		id: `anthropic:${id}`,
		label: id,
		scope: { provider: "anthropic", shared: true, windowId },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 60 * 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function tierLimit(tier: string, usedFraction: number): UsageLimit {
	return {
		id: `anthropic:7d:${tier}`,
		label: `7d ${tier}`,
		scope: { provider: "anthropic", tier, windowId: "7d" },
		window: { id: "7d", label: "7d", resetsAt: Date.now() + 24 * 60 * 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function claudeReport(limits: UsageLimit[], fetchedAt = Date.now()): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt,
		limits,
		metadata: { accountId: "account-1" },
	};
}

/**
 * A sibling that can serve but has nearly nothing left, so credential ranking
 * prefers the blocked-then-healed account whenever the block actually lifts.
 * That makes `getApiKey` a direct read of the healing outcome.
 */
function nearlySpentSiblingReport(): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [sharedLimit("5h", "5h", 0.8), sharedLimit("7d", "7d", 0.97), tierLimit("fable", 0.97)],
		metadata: { accountId: "account-2" },
	};
}

function oauthRow(id: number): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${id}`,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

interface HealHarness {
	storage: AuthStorage;
	clearedScopes: string[];
	/** Persisted blocks, keyed `credentialId:blockScope`, so a test can add one. */
	blocks: Map<string, number>;
	reconcileAfter: Map<string, number>;
}

function makeHarness(
	report: UsageReport | null,
	blockScope = "tier:fable",
	siblingReport = nearlySpentSiblingReport(),
): HealHarness {
	const rows = [oauthRow(1), oauthRow(2)];
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	const blocks = new Map<string, number>();
	const reconcileAfter = new Map<string, number>();
	blocks.set(`1:${blockScope}`, Date.now() + 3 * 24 * 60 * 60_000);
	const clearedScopes: string[] = [];
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => rows,
		upsertAuthCredential: async () => rows,
		async deleteAuthCredentials() {},
		getCredentialBlock: (credentialId: number, _providerKey: string, scope: string) =>
			blocks.get(`${credentialId}:${scope}`),
		getCredentialBlockReconcileAfter: (credentialId, _providerKey, scope) =>
			reconcileAfter.get(`${credentialId}:${scope}`) ?? 0,
		upsertCredentialBlock: block => {
			blocks.set(`${block.credentialId}:${block.blockScope}`, block.blockedUntilMs);
		},
		deleteCredentialBlock: (credentialId: number, _providerKey: string, scope: string) => {
			clearedScopes.push(scope);
			blocks.delete(`${credentialId}:${scope}`);
		},
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
	const usageProvider: UsageProvider = {
		id: "anthropic",
		fetchUsage: async params => {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (access === "access-2") return siblingReport;
			return report;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
		configValueResolver: async value => value,
	});
	return { storage, clearedScopes, blocks, reconcileAfter };
}

describe("claude usage-block healing", () => {
	const storages: AuthStorage[] = [];
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(1_790_465_000_000);
	});
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
		vi.restoreAllMocks();
	});

	it("pairs each tier scope with the shared windows that also gate it", () => {
		const report = claudeReport([
			sharedLimit("5h", "5h", 0.2),
			sharedLimit("7d", "7d", 0.3),
			tierLimit("fable", 0.4),
			tierLimit("opus", 0.5),
		]);
		const scopes = claudeRankingStrategy.healableBlockScopes?.(report) ?? [];
		const fable = scopes.find(scope => scope.blockScope === "tier:fable");

		expect(fable).toBeDefined();
		const ids = (fable?.limits ?? []).map(entry => entry.id);
		expect(ids).toContain("anthropic:7d:fable");
		// Shared walls must judge the scope too, else a spent 5h window heals.
		expect(ids).toContain("anthropic:5h");
		expect(ids).toContain("anthropic:7d");
		// Opus/Sonnet requests never take a scoped block, so nothing to heal.
		expect(ids).not.toContain("anthropic:7d:opus");
		expect(scopes.some(scope => scope.blockScope === "tier:opus")).toBe(false);
	});

	it("lifts a stale tier:fable block when the live report has headroom", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).toContain("tier:fable");
		// The user-visible contract: the recovered account is selectable again,
		// not merely reported healthy.
		expect(await storage.keys.get("anthropic", "s-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
	});

	it("lifts a stale tier:fable block during credential selection without a prior health check", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		expect(await storage.keys.get("anthropic", "s-direct-heal", { modelId: "claude-fable-5-1" })).toBe("access-1");
		expect(clearedScopes).toContain("tier:fable");
	});

	it("keeps the block while the shared 5-hour window is spent", async () => {
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-5h", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("keeps the block when the report omits a shared gate", async () => {
		// The endpoint answers with whatever parsed, so a healthy tier row can
		// arrive without the 5-hour window that may be what blocked the request.
		const { storage, clearedScopes } = makeHarness(
			claudeReport([sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-partial", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it.each(["claude-opus-5-5", "claude-sonnet-4-5"])(
		"selects the recovered account for %s instead of an exhausted sibling",
		async modelId => {
			const { storage, blocks } = makeHarness(
				claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0)]),
				"",
				{
					...claudeReport([sharedLimit("5h", "5h", 1), sharedLimit("7d", "7d", 0.27)]),
					metadata: { accountId: "account-2" },
				},
			);
			storages.push(storage);
			blocks.set("2:", Date.now() + 10 * 60_000);
			await storage.credentials.reload();

			expect(await storage.keys.get("anthropic", "s-recovered", { modelId })).toBe("access-1");
			const health = await storage.health.model("anthropic", { modelId, reserveFraction: 0.1 });
			expect(health.state).toBe("healthy");
			expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("healthy");
		},
	);

	it.each(["5h missing", "7d missing", "5h spent", "7d spent", "opus spent", "sonnet spent", "missing", "stale"])(
		"keeps an unscoped block when the report is %s",
		async condition => {
			const limits = [
				sharedLimit("5h", "5h", condition === "5h spent" ? 1 : 0),
				sharedLimit("7d", "7d", condition === "7d spent" ? 1 : 0),
			].filter(limit => `${limit.window?.id} missing` !== condition);
			if (condition === "opus spent") limits.push(tierLimit("opus", 1));
			if (condition === "sonnet spent") limits.push(tierLimit("sonnet", 1));
			const report =
				condition === "missing"
					? null
					: claudeReport(limits, Date.now() - (condition === "stale" ? 60 * 60_000 : 0));
			const { storage } = makeHarness(report, "");
			storages.push(storage);
			await storage.credentials.reload();

			expect(await storage.keys.get("anthropic", "s-still-blocked", { modelId: "claude-opus-5-5" })).toBe(
				"access-2",
			);
		},
	);

	it("does not clear a recent unscoped rejection using lagging healthy usage", async () => {
		const { storage, reconcileAfter } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0)]),
			"",
		);
		storages.push(storage);
		reconcileAfter.set("1:", Date.now() + 5 * 60_000);
		await storage.credentials.reload();

		expect(await storage.keys.get("anthropic", "s-recent-rejection", { modelId: "claude-opus-5-5" })).toBe(
			"access-2",
		);
	});

	it("recovers from a cached healthy report once the recent-rejection window ends", async () => {
		const now = Date.now();
		const { storage, reconcileAfter } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0), sharedLimit("7d", "7d", 0)]),
			"",
		);
		storages.push(storage);
		reconcileAfter.set("1:", now + 60_000);
		await storage.credentials.reload();
		await storage.usage.reports();

		vi.spyOn(Date, "now").mockReturnValue(now + 60_001);

		expect(await storage.keys.get("anthropic", "s-cached-recovery", { modelId: "claude-opus-5-5" })).toBe("access-1");
	});

	it("keeps the block when the report predates it", async () => {
		// A broker serves its retained last-good report for hours after `/usage`
		// starts failing; those healthy limits describe the account before the
		// 429 that blocked it.
		const stale = claudeReport(
			[sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)],
			Date.now() - 60 * 60_000,
		);
		const { storage, clearedScopes } = makeHarness(stale);
		storages.push(storage);
		await storage.credentials.reload();

		await storage.health.model("anthropic", { modelId: "claude-fable-5-1", reserveFraction: 0.1 });

		expect(clearedScopes).not.toContain("tier:fable");
		expect(await storage.keys.get("anthropic", "s-stale", { modelId: "claude-fable-5-1" })).toBe("access-2");
	});

	it("recovers an account with both stale unscoped and tier blocks", async () => {
		const { storage, blocks } = makeHarness(
			claudeReport([sharedLimit("5h", "5h", 0.1), sharedLimit("7d", "7d", 0.2), tierLimit("fable", 0)]),
		);
		storages.push(storage);
		blocks.set("1:", Date.now() + 60 * 60_000);
		await storage.credentials.reload();

		const health = await storage.health.model("anthropic", {
			modelId: "claude-fable-5-1",
			reserveFraction: 0.1,
		});

		expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("healthy");
		expect(await storage.keys.get("anthropic", "s-recovered-scopes", { modelId: "claude-fable-5-1" })).toBe(
			"access-1",
		);
	});
});
