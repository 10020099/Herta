# 模型服务接口审计：外部依据

## OpenAI Responses API

OpenAI 官方迁移指南确认：Responses API 使用 `POST /v1/responses`，请求主体使用 `input`，而 Chat Completions 使用 `POST /v1/chat/completions` 与 `messages`。官方仍支持 Chat Completions，但建议新集成使用 Responses。

官方来源：

1. [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
2. [OpenAI API Overview](https://developers.openai.com/api/reference/overview/)
3. [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create.md)

OpenAI API Overview 还给出了 `GET /v1/models` 的 Bearer 认证示例，证明官方 OpenAI 的模型发现使用带 `/v1` 的基础路径。

## 本仓库对应审计结论

- 官方 OpenAI 路径以 `https://api.openai.com/v1` 为基础地址并追加 `/responses`，得到 `/v1/responses`，路径模型正确。
- Anthropic 路径以 `https://api.anthropic.com` 为基础地址并追加 `/messages`，得到 `/v1/messages` 的语义由其实现/默认地址组合保证；未发现与 OpenAI-compatible 相同的双路径冲突。
- OpenAI-compatible 旧实现让聊天类请求在 `baseUrl` 后追加 `/chat/completions`，而主对话硬编码追加 `/v1/completions`。若用户填写行业惯例 `https://host/v1`，前者为 `https://host/v1/chat/completions`，后者错误成为 `https://host/v1/v1/completions`；若用户填写根地址，则反向使聊天路径漏掉 `/v1`。因此该模式必须统一为 Chat Completions。
- 除端点冲突外，openai-compat 默认 `routerModel` 为 `""`，启动配置没有用已选择的 backend model 回退，导致路由/标题/摘要请求可能提交空模型名。

该文件仅记录外部事实和接口依据；实现决策与测试在代码及提交历史中追踪。
