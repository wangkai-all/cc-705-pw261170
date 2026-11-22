# SNMP 表采集工作台

按 MIB 定义读取 SNMP 表，并把同一行的各列按 **实例 OID 后缀** 拼合起来的本地演示应用。
Node.js + net-snmp + Vue 3 + SQLite，全部流量只走回环地址。

```
mibs/DEMO-TABLE-MIB.mib     自定义演示 MIB（4 张表）
server/                     Express API、采集器、演示代理、SQLite 存储
shared/                     OID / RFC 2578 索引编解码 / CSV，前后端共用
web/                        Vue 3 单页界面
test/                       node --test 测试
```

## 快速开始

```bash
npm install
npm run build       # 构建 web/dist，由 server 直接托管
npm start           # http://127.0.0.1:3000 ，演示代理在 UDP 127.0.0.1:16161
npm test            # 单元 + 集成测试
```

开发模式（Vite HMR + API 代理）：

```bash
npm run dev         # 127.0.0.1:5173 转发 /api 到 127.0.0.1:3000
```

可选环境变量：`PORT`（网页端口，默认 3000）、`DEMO_AGENT_PORT`（默认 16161）、
`MIB_DIR`（默认 `mibs/`）、`DB_FILE`（默认 `data/runs.sqlite3`）。

## 核心行为

**行由后缀决定，不由响应位置决定。** 每个选中列独立做 GETBULK；收到的每个实例用
`列 OID 之后的子标识` 作为行键。缺失的单元格标 `missing`（该列正常走完但没有这个实例）
或 `not-read`（该列异常中断，还没走到这个实例），绝不会把下一行的值顶上来。

**索引按 MIB 定义解码（RFC 2578 §7.7）。**
- 整数索引占 1 个子标识；
- `IpAddress` 固定 4 个子标识；
- 变长 `OCTET STRING` / `OBJECT IDENTIFIER` 带长度前缀（长度是**字节**数，UTF-8 中文按字节计）；
- 固定 `SIZE` 的字符串不带长度前缀；
- `IMPLIED` 的最后一个索引分量不带长度前缀，吃掉剩余全部子标识。

演示 MIB 里四张表分别覆盖这几种情况：整数索引、复合「整数 + 变长字符串」索引、
`IpAddress + IMPLIED 字符串`、定长 6 字节 MAC 索引（含 0x00 字节）。

**遍历一定会结束。** 每列都会在以下任一情况停止并记录原因（`endReason`），界面上以警告展示：

| 原因 | 含义 |
| --- | --- |
| `subtree-crossed` | 下一个 OID 已离开所选列子树，正常结束 |
| `end-of-mib` | 代理返回 `endOfMibView` |
| `duplicate-oid` | 代理重复了已返回的 OID，没有推进 |
| `out-of-order` | 返回的 OID 比上一个更小 |
| `no-progress` | 响应里没有该列的 varbind |
| `no-such-object` | 代理返回 `noSuchObject` / `noSuchInstance` |
| `timeout` / `error` | 请求超时或返回错误状态 |
| `request-limit` / `varbind-limit` | 达到请求数或 varbind 数上限（500 / 20000） |

**Counter64 保持原精度。** net-snmp 把 Counter64 交成 8 字节 Buffer，采集端用 BigInt
转成十进制字符串，从采集、SQLite 存储、界面到 CSV/JSON 导出全程不经过 `Number`。

## 界面

- **采集**：选表、勾选列、设置批量大小 → 每列显示 OID 与结束原因；结果表按行展示解码后的
  索引；点「来源 OID」展开任意一行，能看到每个单元格来自哪个实例 OID、原始值与十六进制。
  「导出 CSV / JSON」包含 `.value` / `.status` / `.oid` 三列，缺失状态不会被抹掉。
- **演示代理**：开关代理、修改 community、全局异常模式、按列覆盖异常，以及「删除列值」
  矩阵（勾选任意表的任意行/列制造空洞）。改动立即对下一次读取生效。
- **历史记录**：SQLite 中的每次运行，可回看、导出、删除。

## 演示代理

`server/demoAgent.js` 基于 `asn1-ber` + `node:dgram` 手写 SNMPv2c（GET/GETNEXT/GETBULK），
因为成熟代理库不会按需「答错」。可注入的异常模式：

| 模式 | 作用 |
| --- | --- |
| `repeat-last` | 第二次及以后重复上一轮最后一个实例 |
| `out-of-order` | 正常给出 2 个实例后，返回一个更小的 OID |
| `no-advance` | 整个 GETBULK 返回空 varbind 列表 |
| `no-end-of-mib` | 越过列子树后仍反复返回该列最后一个实例 |
| `stop-mid` | 只给前两个实例，然后 `endOfMibView` |
| `timeout` | 丢弃请求，由采集端超时 |
| `error-status` | 返回 `genErr` + errorIndex |
| `omit-column` | 该列从代理视图消失（GET → noSuchInstance，GETBULK 跳过） |

异常只作用于光标实际所在的那一列，不会污染相邻列。每个模式都与采集端的一条终止分支对应，
`test/demoAgent.test.js` 逐个断言。

## 安全边界

- 演示代理只绑定 `127.0.0.1`。
- `/api/collect` 只接受回环主机（`127.0.0.1`、`localhost`、`::1`），拒绝任意远端地址。
- API 中间件拒绝非回环来源的请求（即使将来改了监听地址）。
- 只能采集已从 `mibs/` 载入的表的可读列；列数、批量大小、超时、重试都有上限。
- 导出的 CSV 对以 `= + - @` 开头的值加前缀 `'`，防止表格软件执行公式。
- 演示不需要、也不会连接任何真实网络设备。

## 测试

`npm test` 覆盖：OID 比较（数值而非字符串序）、索引编解码往返与错误拒绝、CSV 转义、
采集器所有终止分支（用可注入的假 session）、真实演示代理下的四张表与全部异常模式、
SQLite 存取与导出、API 参数与回环校验。
