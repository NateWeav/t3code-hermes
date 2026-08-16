import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderQuotaAccount,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentQuotaAccounts, quotaEnvironmentLabel } from "./providerQuota.ts";

function makeAccount(overrides: Partial<ProviderQuotaAccount> = {}): ProviderQuotaAccount {
  return {
    providerInstanceId: "provider-instance-1" as ProviderInstanceId,
    provider: "codex" as ProviderDriverKind,
    displayName: "Codex",
    accountLabel: "user@example.com",
    planLabel: "plus",
    source: "cli",
    status: "ok",
    windows: [
      { id: "weekly", label: "Weekly", usedPercent: 57, resetsAt: null, durationMinutes: null },
    ],
    observedAt: "2026-08-16T10:00:00.000Z",
    message: null,
    ...overrides,
  };
}

describe("presentQuotaAccounts", () => {
  it("drops accounts that never reported windows", () => {
    const accounts = presentQuotaAccounts([
      {
        label: "MacBook",
        accounts: [
          makeAccount(),
          makeAccount({
            providerInstanceId: "provider-instance-2" as ProviderInstanceId,
            provider: "claudeAgent" as ProviderDriverKind,
            status: "setupRequired",
            accountLabel: null,
            planLabel: null,
            windows: [],
            message: "Sign in with Claude Code to show plan limits.",
          }),
          makeAccount({
            providerInstanceId: "provider-instance-3" as ProviderInstanceId,
            status: "failed",
            accountLabel: null,
            planLabel: null,
            windows: [],
            message: "Failed to spawn Codex App Server process",
          }),
        ],
      },
    ]);

    expect(accounts.map((account) => account.providerInstanceId)).toEqual(["provider-instance-1"]);
  });

  it("collapses one account reported by several machines and keeps the freshest report", () => {
    const accounts = presentQuotaAccounts([
      {
        label: "MacBook",
        accounts: [makeAccount({ observedAt: "2026-08-16T10:00:00.000Z" })],
      },
      {
        label: "Desktop",
        accounts: [
          makeAccount({
            providerInstanceId: "provider-instance-2" as ProviderInstanceId,
            observedAt: "2026-08-16T11:00:00.000Z",
            windows: [
              {
                id: "weekly",
                label: "Weekly",
                usedPercent: 61,
                resetsAt: null,
                durationMinutes: null,
              },
            ],
          }),
        ],
      },
    ]);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.windows[0]?.usedPercent).toBe(61);
    expect(accounts[0]?.environmentLabels).toEqual(["MacBook", "Desktop"]);
    expect(quotaEnvironmentLabel(accounts[0]!)).toBe("2 machines");
  });

  it("prefers a healthy report over a stale failed one", () => {
    const accounts = presentQuotaAccounts([
      {
        label: "MacBook",
        accounts: [makeAccount({ status: "failed", observedAt: "2026-08-16T12:00:00.000Z" })],
      },
      { label: "Desktop", accounts: [makeAccount({ status: "ok" })] },
    ]);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.status).toBe("ok");
  });

  it("keeps both cards when one machine reports the same unlabelled identity twice", () => {
    const openCode = {
      provider: "opencode" as ProviderDriverKind,
      displayName: "OpenCode Go",
      accountLabel: null,
      planLabel: "Go",
    };
    const accounts = presentQuotaAccounts([
      {
        label: "MacBook",
        accounts: [
          makeAccount(openCode),
          makeAccount({
            ...openCode,
            providerInstanceId: "provider-instance-2" as ProviderInstanceId,
          }),
        ],
      },
    ]);

    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.environmentLabels.length === 1)).toBe(true);
  });

  it("labels a single machine by name", () => {
    const accounts = presentQuotaAccounts([{ label: "MacBook", accounts: [makeAccount()] }]);

    expect(quotaEnvironmentLabel(accounts[0]!)).toBe("MacBook");
  });
});
