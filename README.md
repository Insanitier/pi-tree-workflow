# pi-tree-workflow

`/marker` `/branch` `/end` — incremental session workflow for long pi sessions.

## Flow

```
Same-branch:  /marker → work, explore, debug → /end → 压缩中间产物
Branch:       /marker → /branch → 新鲜上下文探索 → /end → 压缩分支, 回到 marker
```

## Commands

| Command | Action |
|---------|--------|
| `/marker` | Set checkpoint at current conversation point |
| `/branch` | Jump to fresh context (before first message), keeping marker |
| `/end` | Compress work since marker into summary, advance marker |
| `/end git` | Same + capture git commit suggestion |
| `/end full` | Use pi's default branch summary prompt |
| `/end <text>` | Custom summary focus |

## Install

```sh
pi install /path/to/pi-tree-workflow
# or one-shot:
pi -e /path/to/pi-tree-workflow/index.ts
```

## Design

Built on auto-trees's `/marker`+`/end` compression logic, adding supergsd's
`findFreshTargetId` for branch-style fresh-context navigation. `/end` uses
`navigateTree(markerId, { summarize: true })` which works cross-branch —
same code path for both modes.