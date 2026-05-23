# Remove Deprecated Pages & Backend Plan

目标：彻底删除以下页面及其前后端链路（不提交 commit）。
- K-proxy
- 注册
- 批量订阅
- 关于

## Checklist
- [x] 1. 删除前端页面路由/侧边栏入口/pages 导出/页面文件
- [x] 2. 清理 renderer 中对上述页面能力的剩余引用（如 Settings K-Proxy 开关、ClientConfig 依赖、i18n nav 键）
- [x] 3. 清理 preload 暴露 API（kproxy*、registration*、subscription-page 专用 API）
- [x] 4. 清理 preload 类型声明 index.d.ts 对应条目
- [x] 5. 清理 main 进程 IPC handlers（kproxy-*、registration-*、subscription-page 专用 IPC）
- [x] 6. 删除 main/kproxy 与 main/registration 模块及其接线
- [x] 7. 清理 proxy 层对 kproxy service 的耦合调用
- [x] 8. 全局检索残留引用并修复编译错误
- [x] 9. 输出变更清单 + 风险点




