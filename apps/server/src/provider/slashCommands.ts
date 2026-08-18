/**
 * Shared normalization for the provider snapshot's `slashCommands` field.
 *
 * Every provider that can advertise slash commands (Claude via its
 * initialization result, ACP agents via `available_commands_update`) funnels
 * through {@link dedupeSlashCommands} so the composer menu sees one entry per
 * name regardless of which provider filled the snapshot.
 *
 * @module provider/slashCommands
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";

function nonEmptyString(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * Collapse commands by case-insensitive name, keeping the first occurrence and
 * backfilling a missing description or input hint from later duplicates.
 */
export function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}
