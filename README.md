# OpenClaw Memory System

基于 Claude Code 记忆系统架构设计的 OpenClaw AI 助手记忆扩展模块。

## 特性

- 🧠 **持久化记忆** - 四种记忆类型：user, feedback, project, reference
- 🔒 **团队记忆** - 支持 private/team 作用域隔离
- 📝 **会话记忆** - 自动摘要当前对话关键信息
- 🤖 **AI 检索** - 基于 AI 的相关性记忆选择
- 🔐 **安全防护** - Path traversal 和 symlink 攻击防护

## 安装

```bash
npm install @openclaw/memory
```

## 快速开始

```typescript
import { createMemorySystem } from '@openclaw/memory'

// 创建内存系统
const memory = createMemorySystem({
  directory: './memory',
  autoMemory: { enabled: true },
  sessionMemory: { enabled: true },
})

// 保存记忆
await memory.store.save({
  name: 'user-preference',
  description: 'User prefers detailed output with examples',
  type: 'user',
  content: 'The user is a senior backend engineer...',
  scope: 'private',
})

// 搜索相关记忆
const relevant = await memory.selector.select(
  'backend architecture',
  await memory.store.scan()
)

// 检查并提取会话记忆
if (memory.session.shouldExtract(messages)) {
  await memory.session.extract(messages)
}
```

## 记忆类型

| 类型 | 说明 | 作用域 |
|------|------|--------|
| `user` | 用户角色、偏好、知识背景 | private |
| `feedback` | 用户指导、纠正、确认 | private/team |
| `project` | 项目状态、目标、截止日期 | team |
| `reference` | 外部系统指针、文档位置 | team |

## API 参考

### MemoryStore

```typescript
const store = new MemoryStore(config)

// 保存记忆
await store.save(memory)

// 加载记忆
const memory = await store.load('user', 'preference')

// 更新记忆
await store.update('user', 'preference', { content: '...' })

// 删除记忆
await store.delete('user', 'preference')

// 扫描所有记忆
const memories = await store.scan()

// 搜索记忆
const results = await store.search({ type: 'user', scope: 'private' })
```

### MemorySelector

```typescript
const selector = new MemorySelector(config)

// 选择相关记忆
const selected = await selector.select(query, memories, {
  recentTools: ['bash', 'read'],
  maxResults: 5,
})
```

### SessionMemoryManager

```typescript
const session = new SessionMemoryManager(config)

// 检查是否应该提取
if (session.shouldExtract(messages)) {
  await session.extract(messages)
}

// 手动提取
const result = await session.extractManual(messages)
```

### TeamMemoryManager

```typescript
const team = new TeamMemoryManager(config)

// 保存团队记忆
await team.save({ ...memory, scope: 'team' })

// 扫描团队记忆
const teamMemories = await team.scan()

// 同步团队记忆
const sync = await team.sync()
```

## 安全机制

- **Path Traversal 防护**: 阻止 `../` 路径穿越
- **Symlink 逃逸检测**: 防止通过 symlink 写到目录外
- **Unicode 规范化**: 阻止 `．` → `.` 攻击
- **URL 编码检测**: 阻止 `%2e%2e%2f` 编码攻击

## 配置

```yaml
memory:
  enabled: true
  directory: ./memory
  maxFiles: 200
  maxFileSize: 1048576  # 1MB

  autoMemory:
    enabled: true
    types:
      user: { scope: private }
      feedback: { scope: both }
      project: { scope: team }
      reference: { scope: team }

  sessionMemory:
    enabled: true
    minimumMessageTokensToInit: 1000
    minimumTokensBetweenUpdate: 2000
    toolCallsBetweenUpdates: 10

  aiSelection:
    enabled: true
    model: minimax-cn/MiniMax-M2.7
    maxResults: 5

  security:
    validatePaths: true
    checkSymlinks: true
    maxPathDepth: 10
```

## 目录结构

```
memory/
├── user/                   # 私人记忆
│   ├── MEMORY.md          # 索引
│   └── *.md               # 记忆文件
├── team/                  # 团队记忆
│   ├── MEMORY.md         # 索引
│   └── *.md              # 记忆文件
└── .session-memory/      # 会话记忆
    └── current.md         # 当前会话摘要
```

## 开发

```bash
# 构建
npm run build

# 测试
npm test

# 类型检查
npm run lint
```

## 许可证

MIT
