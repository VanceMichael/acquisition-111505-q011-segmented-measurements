# 复合资料来源约定

## 获取与版本

`GET /deliveries` 返回获准交付件的 id、version、size、sha256、etag 和相对 href。正文支持单一闭区间 Range 及 If-Match；交付更换时旧 ETag 返回 412。来源地址由实际监听端口决定。完整原件相同不表示两个来源交付身份相同。

## 文件支持范围

交付为 CFB major version 3，小端、512 字节普通扇区、64 字节微型扇区，微型流阈值 4096。文件头首512字节之后才是扇区0。头部 DIFAT 列出 FAT 扇区，目录与 MiniFAT 通过各自 FAT 链连接；本地来源不需要额外 DIFAT 扇区。目录项128字节，名称是含终止符的 UTF-16LE，名称长度以字节计；left、right、child 是目录项编号而非字节偏移。对象类型0为空、1为存储、2为流、5为根。流长按目录项的64位无符号值解释，当前支持范围内高32位须为0。FREESECT=0xffffffff、ENDOFCHAIN=0xfffffffe、FATSECT=0xfffffffd。

只有流对象且大小小于4096时，起始编号才属于根微型流和 MiniFAT；根对象自身的流始终经普通 FAT 读取。读取逻辑流按声明长度截取，链余量不是业务正文。目录树颜色不用于排序，目录名称在父存储下比较，不能把不同存储的同名流合并。目录未引用的空槽不是正文。已引用空项、越界、循环、共享分配和不完整链均不可声称内容已确认；影响范围需能回指目录与分配证据。不执行或解释宏、脚本和应用专有流内部内容。

## 现有产品

来源 `POST /__control` 仅用于本地改变 mode=valid|chain-cycle|directory-cycle|shared-sector 与 revision，不属于新增收件 API。`/__state` 可查状态。人工收件接受已确认的 delivery、objectPath 与资料对象；`Archive.accept(source, identity, data, raw)` 保存原始字节并为相同身份保留版本，摘要只复用字节。`src/transport.mjs` 只有一次请求能力，自动遍历与流接收目前未提供。
