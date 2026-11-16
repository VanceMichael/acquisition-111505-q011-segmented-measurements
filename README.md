# 旧式复合交付件的目录对象与内嵌流采集

这是面向资料接收人员的 Node.js 服务。它从本地来源领取 CFB 复合交付件中的目录对象与原始流：只读解析目录层级与分配链，不启动原软件，也不执行或解释流内的宏与嵌入对象。同时保留人工收件、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证解析、归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定默认采集来源，默认 `http://127.0.0.1:4200`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、自动采集、按目录位置领取与链循环隔离，结束即清理，通常只需数秒。

## 容器

`docker build -t compound-streams:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 compound-streams:local` 启动。环境准备后，`docker run --rm --network none compound-streams:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/collect` 从来源领取全部交付件：先按来源目录登记的长度与摘要校验整件，再逐流独立确认后归档。请求体可省略，或以 JSON 指定 `{"source": "http://127.0.0.1:4200"}`。每条流按存储层级路径（如 `/ObjectPool/Summary` 与 `/Properties/Summary` 互不相同）建立业务身份，短流走 MiniFAT、普通流走 FAT；收件数据回指目录项、链上扇区与实际占用的源字节范围。链循环、扇区争用或目录关系损坏的流只登记证据与问题，不按剩余字节猜内容，也不拖累其他可独立确认的流。重采同一原件复用既有身份与版本；供方更换交付后同一身份保留新版本。

`POST /api/claim` 按 `{"receipt", "version"}` 登记的目录位置回源领取流字节：逐范围请求携带登记 ETag，供方更换交付后旧位置返回 409 而不能用于新文件；领取内容须与登记摘要一致。未确认版本与人工收件不支持领取。

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件，`GET /api/records/{receipt}` 查询单条收件及其目录与字节证据，`GET /health` 检查进程。人工记录身份字段为 delivery, objectPath。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`src/` 为解析、采集、领取、收件与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
