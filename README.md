# OpenClaw Memory System

持久化记忆系统，支持 user、feedback、project、reference 四种记忆类型。

## 特性

- **持久化存储** - 基于文件系统的记忆存储，使用 YAML frontmatter
- **作用域隔离** - private（私有）和 team（团队）两种作用域
- **会话记忆** - SessionMemoryManager 管理会话内的记忆提取
- **团队记忆** - TeamMemoryManager 支持团队级别的记忆共享
- **智能选择** - MemorySelector 根据上下文智能选择相关记忆
- **安全防护** - 路径遍历、symlink 逃逸、Unicode 规范化攻击防护
- **事件系统** - 观察者模式，支持记忆变化的订阅
- **缓存层** - LRU 缓存，支持 TTL 过期
- **批量操作** - 支持批量保存/删除，事务支持
- **TTL 清理** - 自动过期清理机制
- **导入/导出** - JSON 格式备份和恢复
- **分页支持** - 大数据集分页查询

## 安装

```bash
npm install
npm run build
```

## 快速开始

```typescript
import { createMemorySystem } from './dist/index.js'

const memory = createMemorySystem({
  directory: './memory',
  maxFiles: 200,
})

// 保存记忆
const saved = await memory.store.save({
  name: 'my-memory',
  description: 'My first memory',
  type: 'user',
  content: 'This is the memory content',
  scope: 'private',
})

// 加载记忆
const loaded = await memory.store.load('user', 'my-memory')
console.log(loaded?.content)

// 扫描所有记忆
const headers = await memory.store.scan()
console.log(`Total memories: ${headers.length}`)

// 搜索记忆
const memories = await memory.store.search({ type: 'user' })
```

## API 文档

### MemoryStore

核心存储类，管理记忆的 CRUD 操作。

```typescript
const store = new MemoryStore({
  directory: './memory',
  maxFiles: 200,
  maxFileSize: 1024 * 1024,
})
```

**方法：**
- `save(memory)` - 保存记忆
- `load(type, name)` - 加载记忆
- `update(type, name, updates)` - 更新记忆
- `delete(type, name)` - 删除记忆
- `scan()` - 扫描所有记忆头部信息
- `scanPaginated(opts)` - 分页扫描
- `search(options)` - 搜索记忆
- `searchPaginated(options, pagination)` - 分页搜索

### 事件系统

```typescript
import { MemoryEventEmitter } from './dist/events.js'

const emitter = new MemoryEventEmitter()

// 订阅特定事件
emitter.on('memory:saved', (event) => {
  console.log('Memory saved:', event.memoryName)
})

// 订阅所有事件
emitter.onAny((event) => {
  console.log('Event:', event.type)
})

// 触发事件
emitter.emitEvent('memory:saved', { memoryName: 'test' })
```

### 缓存层

```typescript
import { MemoryCache, MemoryStoreCache } from './dist/cache.js'

const cache = new MemoryCache<string>({
  maxSize: 100,
  defaultTtl: 5 * 60 * 1000, // 5分钟
})

cache.set('key', 'value')
const value = cache.get('key')
```

### 批量操作

```typescript
import { MemoryBatchProcessor, MemoryTransaction } from './dist/batch.js'

const processor = new MemoryBatchProcessor(store, 5) // 5个并发

// 批量保存
const operations = [
  { type: 'save', memory: { name: 'm1', type: 'user', content: '...', scope: 'private' } },
  { type: 'save', memory: { name: 'm2', type: 'user', content: '...', scope: 'private' } },
]
const result = await processor.execute(operations)

// 事务
const tx = new MemoryTransaction(store)
tx.save({ name: 'm1', type: 'user', content: '...', scope: 'private' })
tx.save({ name: 'm2', type: 'user', content: '...', scope: 'private' })
await tx.commit()
```

### TTL 清理

```typescript
import { TTLCleanupManager, ScheduledCleanup } from './dist/ttl.js'

const cleanup = new TTLCleanupManager(store, [
  {
    enabled: true,
    defaultTtlDays: 30,
    typeOverrides: { project: 7 }, // 项目记忆7天过期
    checkOnStartup: true,
  }
])

// 运行清理
const result = await cleanup.cleanupScope('private')
console.log(`Deleted ${result.deleted} expired memories`)

// 估算清理空间
const estimate = await cleanup.estimateCleanup('private')
console.log(`Would free ${estimate.wouldFreeBytes} bytes`)

// 定时清理
const scheduler = new ScheduledCleanup(cleanup, 24) // 每24小时
scheduler.start()
```

### 导入/导出

```typescript
import { MemoryExporter, MemoryImporter, createBackup, listBackups } from './dist/import-export.js'

const exporter = new MemoryExporter(store)
const importer = new MemoryImporter(store)

// 导出
const data = await exporter.exportToJSON()
await exporter.exportToFile('./backup.json')

// 导入
const result = await importer.importFromData(data, { overwrite: true })

// 创建备份
const backupPath = await createBackup(store, './backups')

// 列出备份
const backups = await listBackups('./backups')
```

### 分页

```typescript
// 分页扫描
const result = await store.scanPaginated({ page: 1, pageSize: 20 })
console.log(`Page ${result.page} of ${result.totalPages}`)
console.log(`Items: ${result.items.length}`)
console.log(`Has next: ${result.hasNext}`)

// 分页搜索
const searchResult = await store.searchPaginated(
  { type: 'user' },
  { page: 2, pageSize: 10 }
)
```

## 测试

```bash
npm test
```

**测试覆盖：**
- MemoryStore CRUD 操作
- SessionMemoryManager 会话管理
- TeamMemoryManager 团队记忆
- 路径安全验证
- Frontmatter 序列化/反序列化
- 事件系统
- 缓存层
- 批量操作
- TTL 清理
- 导入/导出
- 分页

## 项目结构

```
src/
├── index.ts          # 主入口
├── types/            # 类型定义
├── store/            # MemoryStore
├── session/          # SessionMemoryManager
├── team/             # TeamMemoryManager
├── selector/         # MemorySelector
├── security/         # 路径验证
├── utils/            # frontmatter 工具
├── errors.ts         # 自定义错误
├── events.ts         # 事件系统
├── cache.ts          # 缓存层
├── batch.ts          # 批量操作
├── ttl.ts            # TTL 清理
└── import-export.ts  # 导入导出
```

## 安全

- 路径遍历防护 (`../`)
- Symlink 逃逸检测
- Null 字节防护
- URL 编码攻击防护
- Unicode 规范化攻击防护
- 反斜杠防护
- 文件大小限制
- 文件数量限制
