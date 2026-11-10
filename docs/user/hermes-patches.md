# Keep Hermes patches in place

A few T3 Code features need changes to Hermes itself that Hermes has not shipped yet. T3 Code
carries those changes as patches, and **Settings → Hermes** shows whether your Hermes has each one.
On mobile, open **Settings → Hermes → Patches**.

On web and desktop with several environments running Hermes, the page shows each patch on all of them, and **Apply**
and **Remove** act everywhere the patch fits. Choose one environment at the top of the page to see
only its checkout.

Each patch shows one of three states:

- **Applied**: your Hermes has the change.
- **Not applied**: it fits your Hermes. **Apply** adds it.
- **Doesn't apply**: it doesn't fit your Hermes as it is. The page says why:
  - **Hermes is older than this patch**: update Hermes, then it applies.
  - **Waiting for a T3 Code update**: Hermes has moved past the patch. A later T3 Code release
    brings a version that fits.
  - **Local changes in the files this patch touches**: you have uncommitted edits where the patch
    goes. Commit or discard them in the Hermes checkout first.

**Apply all**, at the top of the list, applies every patch that fits, one after another, and stops
at the first one that fails. **Remove** takes an applied patch back out. Applying or removing
affects new Hermes sessions; a chat that is already running keeps the Hermes it started with.

The Hermes gateway, which serves messaging platforms, scheduled tasks, and webhooks, keeps running
the code it started with. When it started before your latest patch change, the page says so and
offers **Restart gateway**. Apply or remove everything you want first, then restart once: the
gateway finishes the chats, tasks, and webhook runs it is working on before it restarts. A gateway
started with `hermes gateway run` in a terminal does not run as a service, so restart it there.

## Update Hermes

When a patch is waiting on a newer Hermes, the page offers **Update Hermes**. It removes T3 Code's
applied patches, updates Hermes, then puts back each one using the version that fits the new
Hermes. Afterwards the page says what was reapplied and what is now waiting for a T3 Code update. If
the update fails, the patches you had are put back. Updating Hermes from its provider card in
Settings does the same, then restarts a gateway that runs as a service.

Uncommitted edits of your own in the checkout are carried over the update. When an edit no longer
fits the new Hermes, Hermes keeps it in a git stash and the result names that stash, so you can
bring it back with `git stash apply`. If you set Hermes's `updates.non_interactive_local_changes` to
`discard`, Hermes drops those edits instead. It leaves a running Hermes gateway alone, so it never
restarts without its patches; restart it afterwards with **Restart gateway**, as after any patch
change. Hermes from before September 2026 always restarts
its gateway while updating, before the patches are back, so restart it once more afterwards.

## Things to know

- Patches need Hermes installed from a git checkout, the same kind of install that can update
  itself. Package-manager and container installs show why the page has nothing to do.
- Running `hermes update` yourself parks applied patches in a git stash and puts them back. When
  that restore conflicts, Hermes leaves them in the stash and the page shows them as not applied;
  apply them again here. If an update leaves a patch no longer fitting, the page shows it as
  **Doesn't apply** rather than failing the update.
