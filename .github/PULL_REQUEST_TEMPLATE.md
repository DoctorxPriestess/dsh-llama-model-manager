# Pull request

## What does this change?

<!-- One or two sentences. Link the issue it closes, if any. -->

Closes #

## Why?

<!-- The problem being solved, not just the mechanism. -->

## How was it verified?

<!--
  "Tests pass" is the minimum. If you touched the process/stop/cleanup paths,
  paste the output of the relevant end-to-end script.
-->

- [ ] `npm test` is green
- [ ] `npm run preflight` is green (if `package.json` / `cordis.patch.yml` changed)
- [ ] Ran `npm run e2e:ctrlc` and/or `npm run e2e:orphan` (if the process path changed)

```
paste output here if applicable
```

## Checklist

- [ ] No new runtime dependencies
- [ ] No new build step
- [ ] Any new subprocess is spawned with `windowsHide: true`
- [ ] No `uncaughtException` / `unhandledRejection` listener added to the host plugin
- [ ] No bare-pid kill where a child handle is available
- [ ] Comments explain *why* where the code contradicts the obvious approach
- [ ] README updated if user-visible behaviour or settings changed
- [ ] CHANGELOG updated (for user-visible changes)
