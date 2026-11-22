# mend — 4 formats, 3 matching tiers, 0 edits lost

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jo3st4r/hidden-spec-cli-01-bot/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jo3st4r/hidden-spec-cli-01-bot/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files — in any of the four
formats models actually write: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. One file, `main.ts`
(Node 22, standard library only, no dependencies), run as
`node main.ts [options] [PATCH]`.

## How it works

Every edit names old lines O replaced by new lines N. O is found at the first
of three matching tiers where it occurs at least once — exact, then trailing
whitespace ignored, then leading and trailing whitespace ignored — so a diff
whose line numbers are wrong still lands, and a hunk whose indentation drifted
still lands with its new lines re-indented to the file's own indent. A unified
hunk takes the occurrence nearest its (wrong) line number; a SEARCH/REPLACE
block insists on exactly one occurrence; a V4A chunk walks a cursor past its
anchor and takes the first occurrence at or after it.

Each format is read exactly as SPEC.md says, including the sharp edges:
`\ No newline at end of file` decides the final line break, CRLF files keep
their own break, created files end with a break unless the patch says
otherwise, and a move prints one `R old -> new` line. Edits apply in patch
order to the tree the earlier edits left; a failed edit changes nothing and
the edits after it still run; when any edit failed, no file is written
(exit 1, one `error: <code> <path>` line per failure, then
`failed: <k> of <n> edits`). `--check` reports what would change and writes
nothing; `--strict` matches exactly (tier 0 only).

## Results

Practice set (100 checks: 30 unified, 20 search_replace, 20 v4a, 15 json,
15 cli), run with the kit's own `check.ts` — and all three practice trials
run through the kit's own `runner.ts` against their own checks and reference
outcomes:

- Practice score: **1000** — 100 of 100 checks on every trial (trial-0,
  trial-1, trial-2), every group at full marks.
- 36 extra hand-written edge cases (no-newline markers, pure moves, empty
  creations, malformed headers, usage errors, `--check`, unsafe paths,
  V4A anchor/EOF/move cases, JSON faults): **36 of 36 passed**.
- Trial handover verified against a local env server: checks fetched, results
  posted, exit 0.

## Run it

```sh
# apply a patch file
node main.ts fix.patch

# read the patch from stdin, dry run
node main.ts --check -

# grade against the practice set (from the kit directory)
node check.ts program/generator/practice.json
```

## License

MIT — see [LICENSE](LICENSE).
