# pi-tree-workflow — Design

## 哲学

一条命令入口（`/marker`），所有操作通过 TUI 完成。不设独立 `/branch`、`/end`、`/jump-marker`、`/list-markers` 命令。

## 命令

| 用法 | 作用 |
|------|------|
| `/marker <name>` | 在当前节点创建标记 `<name>`，不经过 TUI |
| `/marker` | 打开标记管理器 TUI |

## 数据模型

每个标记 = 一条 `MARKER_ENTRY`（`customType: "tree-workflow-marker"`），通过 `pi.appendEntry()` 持久化在分支内。

```typescript
interface MarkerData {
    name: string;      // 如 "explore-api"
    targetId: string;  // 标记所在 entry 的 ID
}
```

标记查询：`readMarkers()` 扫描 `ctx.sessionManager.getBranch()`，收集所有 `MARKER_ENTRY` 条目，按 name 去重（同名后写覆盖前写）。删除标记时追加同名 `deleted: true` 的 tombstone 条目（shadow 旧条目，不破坏历史）。

**没有 STATE_ENTRY**。`/branch` 和 `/end` 作为独立命令已取消。TUI 里的 Summarize 操作直接调用 `navigateTree(marker.targetId, { summarize: true, instructions })`，不需要预先存储 `markerId`。

## 标签格式

`setLabel(targetId, name)`。如标记 `explore-api`，TUI 显示 `explore-api`。不加 "Marker" 前缀。

## 重名策略

同名标记自动编号：`explore-api` → `explore-api-2` → `explore-api-3`。不覆盖，不报错。

## TUI 流程

两层 `ctx.ui.select()`：

```
Level 1 — 标记列表:
  ○ explore-api
  ○ fix-parse-bug
  ○ review-diff-2
  ══════════════════════
  + Set new marker here

Level 2 — 对 "explore-api" 的操作:
  ○ Jump              → navigateTree(id, summarize: false)
  ○ Summarize & Jump  → 弹出 prompt 选择器 → navigateTree(id, summarize: true)
  ○ Delete            → 清除 setLabel + 追加 tombstone 条目
  ← Back

Level 2 (Summarize & Jump) 的 prompt 选择器:
  沿用现有 Default + 自定义 prompt 的管理（create/delete/select）
```

## 标签清理

每个标签的 name 是唯一的（自动编号避免冲突），所以不存在不同标签争抢同一个 `setLabel` 值的问题。`setLabel` 只设置，不清除旧的。

删除标记时：`pi.setLabel(targetId, undefined)` + 追加 `{ name, targetId, deleted: true }` 的 tombstone 条目。

## 引用的参考实现

| 项目 | 来源 | 复用部分 | 差异 |
|------|------|----------|------|
| pi-auto-trees | npm:@howaboua/pi-auto-trees | `getSemanticLeafId` while 循环、`appendEntry` 持久化模式 | 单标记 vs 多标记；固定标签 vs 命名标签 |
| pi-supergsd | npm:pi-supergsd (skhoroshavin) | `findFreshTargetId` / `findPreConversationEntry` 模式、entry-based 状态存储 | task 系统 vs 标记系统；summarize: false vs summarize: true |
| pi-jump-tree | github:xRyul/pi-jump-tree | 不直接复用 | 跨 session 跳转，与标记系统正交 |

## 弃用的旧功能

以下命令和状态在本次重写中删除：
- `/branch` → TUI 无对应功能（基于分歧时用户需求不够明确，延后）
- `/end` → 被 TUI 的 Summarize & Jump 取代
- `/list-markers` → 被 TUI 的标记列表取代
- `/jump-marker <n>` → 被 TUI 的 Jump 取代
- `STATE_ENTRY` → 不需要了，只用 `MARKER_ENTRY`
- `lastMarkerLabelTarget` → 每个标签唯一，无冲突

## 向后兼容

旧 session 中遗留的 `STATE_ENTRY` 不影响新代码运行。`readMarkers()` 不会读取它们，所以它们不会出现在 TUI 中。用户可以在旧标记位置重新 `/marker <name>` 来创建命名标记。

## 未实现（备用）

- **Branch / fork 到新 session**：从当前节点分裂出新会话，可携带前 N 条消息。功能与标记系统正交，独立开发。
- **TUI `/viz`**：标记可视化树形图。当前认为 `/marker` TUI 的列表已够用。