# 合作来源约定

## 资料边界

网关 measurement 文件为公开的台架分段交换子集：每段 header 指定 nextOffset、rawOffset、layout=contiguous|interleaved、metadataMode=replace|inherit；channel 按 group/path 标识，dataType、count、unit、scale 和 start/step 可逐段改变。metadataMode=inherit 仅省略重复元数据，仍须按该段 raw 区间接收新增样本，不代表通道消失。原始段是 LE float64 或 int16；nextOffset=-1 为未封口尾段。详见 fixtures/layout.json 的偏移表。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/measurements`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
