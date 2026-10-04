# Fast mode with Hermes

Some models can answer faster for a higher price. When the model you have selected supports it, the
composer's model options include a **Fast Mode** toggle, the same one Claude and Codex offer. It
applies to that thread from your next message.

## When the toggle appears

Hermes decides, using the same rules as its own `/fast` command: the model has to support fast mode
and Hermes has to be talking to the provider that bills for it, such as OpenAI, ChatGPT, Anthropic,
or xAI. Hermes needs the Fast mode patch from the Patches tab of the Hermes panel; without it the
toggle does not appear.

## Using it through a proxy

Hermes never sends fast-mode settings to a custom endpoint unless you say the endpoint accepts them.
For a proxy that forwards them to OpenAI or ChatGPT, such as CLIProxyAPI, add this to that provider's
entry in Hermes's `config.yaml`:

```yaml
capabilities:
  fast_mode: true
```

Then refresh providers in **Settings → Providers** so the toggle shows up for that provider's GPT
models. Claude models behind a proxy are not covered: Claude's fast mode needs
Anthropic's own API format, which proxies reached over chat completions do not pass through.

## Things to know

- Fast mode uses more of your plan or credits. Turn it off from the same toggle.
- A proxy may report every request as the standard tier even when fast mode took effect. The
  speed difference is the reliable sign.
