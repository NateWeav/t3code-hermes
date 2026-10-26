# Use T3 Code subagents with Hermes

Hermes has its own subagent tool. Unless the Live subagent progress patch is applied, T3 Code cannot
see when one of those subagents finishes, so an agent can end its turn waiting for a result that
never arrives. T3 Code's own subagents always report back, show as child threads, and can run any
model you have set up.

To make Hermes agents use only T3 Code subagents, turn on **Use T3 Code subagents only** under
Settings → Providers → Hermes. It is off by default.

## Things to know

- The setting turns off Hermes's `delegation` toolset in your Hermes `config.yaml`. That file is
  shared with the `hermes` command line and gateway, so Hermes's own subagents are off there too
  while the setting is on.
- Turning it off removes only the entry T3 Code added. If you disabled `delegation` yourself, it
  stays disabled.
- It applies from the next Hermes session. A conversation already in progress keeps the tools it
  started with.
- A config file that cannot be read is never overwritten. If `agent.disabled_toolsets` is written as
  a single line of text instead of a list, T3 Code leaves it alone.
