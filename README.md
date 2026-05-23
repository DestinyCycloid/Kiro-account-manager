# Kiro Account Manager

轻量、稳定的 Kiro 多账号管理与 API 反代工具。

## Core Features
- 多账号管理：新增、编辑、分组、标签、批量操作
- 一键切号：快速切换当前活跃账号
- 自动刷新 Token：过期前自动续期并同步状态
- API 反向代理：统一 OpenAI/Claude 兼容入口
- 机器码管理：查看、切换、绑定账号机器码
- Kiro 设置管理：MCP、Steering、常用配置编辑
- 托盘与快捷键：后台运行、快捷呼出窗口

## Tech Stack
- Electron + React + TypeScript
- Zustand
- Tailwind CSS + Radix UI

## Development
```bash
npm install
npm run dev
npm run build
npm run typecheck
```

## Notes
- 当前仓库聚焦核心管理与代理能力。
- 详细变更请查看 `docs/remove-pages-plan.md` 与提交历史。
