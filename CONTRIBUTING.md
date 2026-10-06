# 贡献指南

感谢你为 ForestQ Codex ImageGen 提交改进。

## 开始开发

项目需要 Node.js 18.17 或更高版本，不依赖额外的 npm 包。运行测试：

```bash
npm test
```

提交前请确认测试通过，并在变更说明中写清楚行为变化。涉及 API 调用的测试应继续使用仓库内的假中转站，不要提交真实 API key、生成结果或本地 corpus。

## 提交问题和 Pull Request

请在 issue 或 Pull Request 中描述复现步骤、运行环境和预期行为。新增配置项或 CLI/MCP 行为时，请同步更新 README 和相关测试。

## 许可和来源

代码以 MIT License 发布。项目中的模板、提示词方法和 Mondo 海报资料包含上游项目及公开资料的署名要求，请保留现有版权和来源说明。
