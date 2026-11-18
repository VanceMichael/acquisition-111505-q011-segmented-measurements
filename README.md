# 旧式复合交付件的目录对象与内嵌流采集

这是面向资料接收人员的 Node.js 服务。服务可以从合作方来源直接领取旧式复合（Compound File Binary v3）交付件，按目录对象领取存储与内嵌流，保存原始字节与版本记录，并回答某个流在源文件里实际占用了哪些字节。宏、脚本和嵌入对象只作为原始字节搬运，不执行、不解释。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、来源行为与复合文件解析。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、自动领取三种损坏情景与流查询，结束即清理，通常只需数秒。

## 容器

`docker build -t compound-streams:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 compound-streams:local` 启动。环境准备后，`docker run --rm --network none compound-streams:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查全部功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本，`GET /health` 检查进程。人工记录身份字段为 delivery, objectPath。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs、按业务身份保存的 receipts，以及自动领取时按目录对象额外保存的流字节。

`POST /api/collect` 领取自动来源交付件：

```
curl -s -X POST localhost:3200/api/collect \
  -H 'content-type: application/json' \
  -d '{"source":"http://127.0.0.1:4200"}'
```

返回每个目录对象的路径、类型、状态、问题原因与源分配证据。普通流经 FAT，大小小于 4096 的短流经根微型流与 MiniFAT，根对象自身的流始终经 FAT；同一存储下的同名对象按路径区分。链循环、链过短、越界、共享扇区或目录关系损坏时，只把相关对象标为 `unconfirmed`，其他可独立确认的流照常领取，问题记录保留目录项编号、路径与该对象完整的分配链。供方替换文件后旧 ETag 返回 409，必须按新目录重新领取；重采同一原件不会产生第二套对象身份。

`GET /api/records/:receipt?entryIndex=3` 回到目录项，`GET /api/records/:receipt/objects/3` 取流正文，`?format=source` 取该流在源文件中实际占用的字节。未确认对象返回 409 并附原因。

`src/` 为收件、传输与复合文件读取（`src/compound.mjs` 解析、`src/collect.mjs` 领取与查询），`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 覆盖上述行为。协议范围与局部身份约定见 `docs/source-contract.md`。
