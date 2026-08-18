# Reasoning effort with Hermes

Some models can be asked to think harder before answering. When the model you have selected supports
it, a **Reasoning** control appears in the composer next to the model picker, offering the levels
that model actually accepts. Hermes uses its default reasoning level unless you choose another one.

## What the levels mean for your setup

The list is not the same for every model. T3 Code reads the model database Hermes already keeps on
disk to decide which models can reason at all, and trims the list where a provider refuses the
higher levels. If a model cannot reason, no control appears rather than one that does nothing. If a
model is forced to think, the control is hidden rather than offering an off option.

If Hermes has not yet built its model database, the control is hidden rather than guessed at. It
appears once Hermes has refreshed that data.

## Where the setting is saved

Choosing a level records it in your own Hermes configuration, against that specific model. This is
the same file the `hermes` command line reads, so a level you pick in T3 Code is the level your
terminal sessions use, and vice versa. Nothing else in that file is changed, and a configuration
file that cannot be read is never overwritten.

The level applies from your next message, not to a reply already in progress.

## Making it take effect

Hermes's agent-protocol interface — the one T3 Code talks to — does not read the configured
reasoning level on its own; it is the only Hermes surface that skips it. Until that is fixed
upstream, the level you pick is recorded correctly but ignored while Hermes runs. Applying the small
patch shipped in the fork's `infra/hermes` directory to your Hermes installation makes Hermes honour
it. Without the patch the control still appears and still saves your choice, but Hermes keeps using
its own default.
