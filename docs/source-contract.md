# 复合资料来源约定

## 获取与版本

`GET /deliveries` 返回获准交付件的 id、version、size、sha256、etag 和相对 href。正文支持单一闭区间 Range 及 If-Match；交付更换时旧 ETag 返回 412。来源地址由实际监听端口决定。完整原件相同不表示两个来源交付身份相同。

## 文件支持范围

交付为 CFB major version 3，小端、512 字节普通扇区、64 字节微型扇区，微型流阈值 4096。文件头首512字节之后才是扇区0。头部 DIFAT 列出 FAT 扇区，目录与 MiniFAT 通过各自 FAT 链连接；本地来源不需要额外 DIFAT 扇区。目录项128字节，名称是含终止符的 UTF-16LE，名称长度以字节计；left、right、child 是目录项编号而非字节偏移。对象类型0为空、1为存储、2为流、5为根。流长按目录项的64位无符号值解释，当前支持范围内高32位须为0。FREESECT=0xffffffff、ENDOFCHAIN=0xfffffffe、FATSECT=0xfffffffd。

只有流对象且大小小于4096时，起始编号才属于根微型流和 MiniFAT；根对象自身的流始终经普通 FAT 读取。读取逻辑流按声明长度截取，链余量不是业务正文。目录树颜色不用于排序，目录名称在父存储下比较，不能把不同存储的同名流合并。目录未引用的空槽不是正文。已引用空项、越界、循环、共享分配和不完整链均不可声称内容已确认；影响范围需能回指目录与分配证据。不执行或解释宏、脚本和应用专有流内部内容。

## 自动领取

`POST /api/collect` 接受 `{ "source": "http://来源地址", "delivery": "cabinet-a" }`，`delivery` 在只有一个交付件时可省略；正文为纯文本来源地址也可。服务先列交付件，再以清单中的 ETag 作为 If-Match 下载，核对长度与 sha256 后解析。若清单之后供方已更换文件，来源返回 412，服务返回 409 `delivery-changed`，不会把旧目录位置用于新字节；也可显式传 `etag`、`sha256` 或 `revision` 固定先前观察，任一不符同样返回 409。

解析按目录对象逐项给出 `path`、`kind`、`status`、`issues` 和 `source`。`source` 记录分配类型（`mini`/`fat`/`none`）、起始编号、完整链与源文件字节区间；普通流只使用 FAT，短流只使用 MiniFAT，根微型流始终使用 FAT。同一存储下的同名对象按路径区分，不同存储的同名流不合并。

损坏隔离以流为单位：某条链循环、链短于声明长度、越界，或目录关系损坏时，仅该对象 `status` 为 `unconfirmed`、`contentSha256` 为 `null`，问题写入 `issues` 并可回指目录项编号与分配证据；其他可独立确认的流仍正常领取。多个对象引用同一源扇区（含 FAT、目录、MiniFAT 等结构扇区）时，涉及的业务流都标为 `unconfirmed` 并给出争用双方。目录树无法归属的对象保留目录项编号与名称作为证据，不按剩余字节推测正文。重复采集同一原件按原件摘要复用版本，不会生成第二套对象身份；供方替换文件则成为同一收件的新版本，各自保留自己的目录与偏移。

## 查询

`GET /api/records` 列出人工与自动收件，`GET /api/records/:receipt` 返回指定版本（`?version=`），加 `?entryIndex=` 或 `?path=` 时同时返回该目录项。`GET /api/records/:receipt/objects/:entryIndex` 返回该流已保存的正文，`?format=source` 返回它在源文件中实际占用的字节（含扇区余量）。未确认的对象对两种读取都返回 409，并带上未确认原因。人工收件没有目录对象，选择器返回 409 `not-collected`。

## 现有产品

来源 `POST /__control` 仅用于本地改变 mode=valid|chain-cycle|directory-cycle|shared-sector 与 revision，不属于新增收件 API。`/__state` 可查状态。人工收件接受已确认的 delivery、objectPath 与资料对象；`Archive.accept(source, identity, data, raw)` 保存原始字节并为相同身份保留版本，摘要只复用字节。`src/transport.mjs` 提供单次请求能力，自动遍历与流接收见 `src/collect.mjs` 与 `src/compound.mjs`。
