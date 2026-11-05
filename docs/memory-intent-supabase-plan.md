# 记忆分层、结构化意图与 Supabase 改造方案

日期：2026-10-29。状态：代码审查与架构建议，尚未实现或迁移。此次只新增本文档，不修改现有业务逻辑、不连接外部数据库、不调用收费模型接口。

后续进展：同日已完成第一阶段的意图模块与会话观察实现，具体范围、测试及尚未完成项以 [第一阶段说明](memory-phase-one.md) 为准。本文以下保留制定方案时的现状，Supabase 仍未迁移。

## 1. 当前事实

| 实现 | 长期记录位置 | 当前观察/任务 | 意图理解 |
| --- | --- | --- | --- |
| 基础网页 | 当前浏览器 localStorage；物品键 spatial-memory.records.v1 | runtime.currentScene、observedAt、SessionContext、ObservationGate 等已有局部实现 | 规则与千问工具混合；有 query_memory、request_observation、prepare_memory 等工具 |
| 完整三样本网页 | demo/server.py 的 DEMO_DATA_DIR/memories.sqlite3；未设置时为源码根目录 .demo-data；Docker 默认 /mnt/workspace/iseeyou | Session 的 last_image、focus、references、任务状态与 epoch，主要在后台内存 | demo/engine.py 的 intent() 主要靠正则；语音转写进入同一文字指令路径 |
| 安卓 | 手机应用私有 Room 数据库 spatial-memory.db，加 filesDir/object-memory 下的样本图 | 原生找物状态机、画面与对话上下文 | FindDialogueEngine 规则；report_target_visibility 工具用于视觉复核，非通用意图解析 |
| iOS 0.1 测试工程 | 完整物品记忆复用配置的网页后台；聊天与网页身份在应用 WKWebView 数据存储中 | 复用完整网页任务；没有另建独立记忆库 | 同完整三样本网页 |

本次没有在交付目录找到实际 .db/.sqlite3 用户数据库。源码和数据结构不是用户数据：线上数据应到真实部署的数据卷取，浏览器记录应从对应浏览器导出，安卓数据需从对应安装应用导出。未登录部署控制台，不推断线上数据量或是否已有其他部署。

完整网页现有两张表：objects 保存名称、外观、location、recorded_at、owner；samples 保存三张 JPEG BLOB 和颜色特征。相同 owner+normalized 名称只保留一条物品，更新时替换样本和位置，不具备完整位置事件历史。

## 2. 已经区分历史和当前，但没有统一完成分层

已经具备：history 分支查持久记录并说历史位置未确认；describe 使用画面；search 利用参考样本核对当前画面；用户明确记住后再保存。基础网页还用 currentScene 保存观察结果，并有局部帧/任务校验。

不足：不同端分流不一致；观察记录缺少统一可查询结构；证据过期和场景切换失效没有统一策略；长期位置缺少清晰事件历史。普通画面描述还会附带全部长期记录，增加历史内容影响当前回答的机会。

完整网页 describe 的等待循环尝试等新画面，但超时后只检查 last_image 是否存在，没有再次严格拒绝过期图片。last_frame 又用于接收/活动时间，因此应独立保存和校验图片自身的 captured_at、frame_id、处理完成状态。不能仅依据活动时间或提示词认定画面新鲜。

纯函数审计（不启动服务、不导入模型、不访问云端）：

| 输入 | 当前 intent() 返回 |
| --- | --- |
| 帮我记住蓝色水杯 | remember / 蓝色水杯 |
| 蓝色水杯上次放在哪里 | history / 蓝色水杯 |
| 上次记住的蓝色水杯现在在哪 | history / 蓝色水杯现在（时间和目标均错误） |
| 我想把这个杯子记下来 | describe / 原话（未进入保存意图） |
| 拿到了 | complete |

这些结果仅验证现有解析函数，不是端到端模型或识别测试。

## 3. 采用两层记忆，独立管理当前证据有效性

短期记忆应包括：当前画面识别出的对象、位置关系、当前目标、指代对象、已看过的区域、临时线索和待澄清问题。描述是这些信息的一种输出。短期是作用范围，不等于必须写到某种数据库。

长期记忆应包括：用户要求保存的个人物品身份、多个外观样本、位置事件、别名、时间和来源。今天刚保存的物品也属于长期记忆；历史记录不因刚刚查过就变为当前事实。

当前观察建议字段：session_id、observation_id、frame_id、captured_at、analyzed_at、expires_at、scene_revision、objects、relations、evidence_status。图像和临时上下文先放运行内存；多实例运行再考虑 Redis 或共享会话存储。若为了恢复会话而持久化，恢复后仍须重新判断画面是否有效。

不要把所有短期上下文都设成同一过期时间：画面位置证据应在超时、转镜头或切场景时失效；当前寻找目标则保留到完成或取消。具体时限需真机按延迟、运动和识别效果确定，不把固定秒数当成准确性保证。

规则：

1. “现在有什么”仅使用有效当前证据；过期或没有新画面就重新取景。
2. “上次放在哪”查长期事件，说明记录时间、来源和未确认现状。
3. “之前记住的杯子现在在哪”用长期记忆解析物品身份，再用当前画面确认位置。
4. “刚才看到的杯子”可查本轮短期观察，但用过去时回答，不能假定仍在。
5. 短期观察不自动提升为长期事实。用户明确记住、对象唯一、证据核对和存储提交成功后才保存。仅缺位置时可以保存外观并明确位置未知。
6. 用户直接说“记住，钥匙在抽屉里”可保存为用户陈述，不能伪装成相机确认。用户提供的“可能在厨房”只作临时线索，除非明确要求保存。

## 4. Supabase 目标结构

建议：继续使用 FastAPI/Yolo 作为计算和任务后端，Supabase Auth 负责用户身份，Postgres 负责长期记录，私有 Storage bucket 负责样本图。存储迁移不会自动运行现有 Python/LiteRT 推理服务。

| 数据表/服务 | 建议内容 |
| --- | --- |
| Auth | 可恢复的账号身份；跨设备同步需要登录同一账号 |
| objects | id、user_id、display_name、aliases、description、created_at、updated_at、status |
| appearance_samples | id、user_id、object_id、storage_path、feature、feature_model_version、captured_at、quality |
| location_events | id、user_id、object_id、location、anchor、observed_at、recorded_at、source、verification_status、evidence_observation_id |
| 私有 Storage bucket | 用户范围内的 JPEG 样本文件；表里存 bucket/path，不永久保存会过期的签名 URL |
| messages（可选） | 经用户选择同步的对话；不可直接作为已确认物品事实 |

物品主键使用独立 ID；名称用于搜索和澄清，不作身份唯一依据。位置更新追加事件，不覆盖全部历史。observed_at 是实际看见或用户明确提供的事件时间；未知就留空，recorded_at 是写入时间，updated_at 是编辑时间，三者不可互相冒充。

示例：objects 中保留同一蓝杯身份；location_events 分别记录“昨天书桌”“今天厨房”。用户更正记录时保留更正关联，查询只采用未撤销、相关且来源清楚的事件。

授权：每行关联 user_id，并以 Auth JWT 的实际身份做表和 Storage 授权。后台从已验证的登录信息派生 user_id，不相信模型输出或客户端随意传来的 owner。Supabase service_role/secret 类管理密钥仅放后台；使用管理密钥的后台会绕过 RLS，因此后台自身必须明确限制用户范围。

## 5. 迁移方法

SQLite/Room 数据文件不能直接当作 Supabase Postgres 数据库使用；把 .db 上传到 Storage 只得到备份文件。

1. 确认实际数据源，做一致性导出；运行中的 SQLite 用备份接口或暂停写入快照，不能只复制正在写入的主文件。
2. 在 Supabase 建表、Auth 和私有 bucket，建立 user_id 的授权规则。旧匿名 Cookie owner 必须通过旧会话持有证明安全关联到新账号，不能让用户认领任意 owner。
3. 导出物品和特征；从网页 SQLite BLOB 或安卓私有图片文件提取 JPEG，上传 Storage；保留对象对应关系、时间和特征版本。
4. 导入 objects、appearance_samples 和 location_events。旧记录只有 recorded_at 时，不假造 observed_at；标注旧版来源和时间不确定。
5. 将原 Store 接口抽象成仓储层，分别实现 SQLite 和 Supabase 后端，保留切回旧版的能力。
6. 对图像上传和数据库提交采用 staged/pending → active 流程：图片齐全、元数据提交成功才宣布保存。Storage 与 Postgres 不是同一个原子事务，失败时清理孤立图片并保留原 active 记忆。
7. 校验用户隔离、物品/样本数量、图片摘要、历史查询和重开读取，再切换写入。保留旧库的只读备份；不要用无冲突设计的双向同步。

初期也可以继续 SQLite+持久磁盘+一致性备份，先验证分层与意图。若需要账号同步和网页/iOS/安卓共享，Supabase 更有价值。若选其他基础设施，同样可用托管 Postgres+私有对象存储，不改变上述数据模型。

不必先做向量数据库。少量物品先用对象 ID、名称、别名和时间检索；pgvector 可作为后续语义召回手段，但不会让当前 48 维颜色特征自动变成可靠的物品身份模型，也不会自动区分历史和当前。

## 6. 意图层：先复用千问，程序控制执行

概念上是独立模块，不要求单独引入另一家模型。建议对普通句子增加一次独立的文本解析请求，先用现有千问模型和网关做能力验证；语音通道仍只负责转写和朗读。若后续延迟或成本不合适，再切换同一家较小文本模型，不必改意图协议。

当前完整网页的实时 session 配置 tools=[]，故不能认为已有通用语音工具路由。基础网页已有 query_memory 等工具经验可复用，但这条路径与完整网页不是同一套。

当前代码使用 qwen3.8-omni-flash 与项目特定网关。官方文档列出该模型支持 JSON Object，但不能据此保证当前网关完整支持 response_format 或 Function Calling；上线前用实际 endpoint 单独测试。JSON Schema 严格模式仅适用于支持的具体模型/配置，不能直接假定实时、多模态接口全部可用。

建议链路：

原话/语音转写 → 确定性停止/取消等快速通道 → 千问结构化解析 → 服务端 schema 和语义校验 → 身份/时间/对象消歧 → 任务执行 → 带来源的回执。

输入模型：原话、最近少量对话、当前任务摘要、当前指代候选；需要时附少量相关记忆名称。不要每次附全部历史和全部照片。解析阶段不需要视觉输入；“这个”指向谁由当前观察和程序消歧，模型不能凭文字捏造物品 ID。

意图建议：describe_current_scene、find_object、recall_location、remember_object、update_location、list_memories、delete_memory、continue_search、complete_search、cancel、clarify。首版一次处理一个主任务，复合请求可返回有序动作，但必须定义取消优先级和写入授权。

输出示例（提案，非已实现）：

```json
{
  "schema_version": 1,
  "intent": "find_object",
  "target_text": "蓝色水杯",
  "target_reference": "saved_object",
  "time_scope": "current",
  "location_text": null,
  "needs_clarification": false,
  "clarification_question": null
}
```

对应“上次记住的蓝色水杯现在在哪”：saved_object 表示物品来自历史记忆，current 表示要查当前位置。用户身份、数据库 object_id、授权、是否允许写入以及完成状态由程序确定，不由模型生成。

可以使用 JSON Object + Pydantic 校验，或 Function Calling 返回参数后仍校验。先选一种协议即可。schema 合法只保证格式，不保证理解正确；再验证否定、时态、对象唯一性、当前证据、写入指令和状态转换。

写入接口仅接受白名单动作，不执行模型生成的 SQL；没有实际保存回执不说已经保存。请求带 request_id 去重，绑定 task_id/epoch，取消后丢弃在途意图结果，避免语音与文字双触发。模型失败时明确提示，可保留固定口令作为降级；停止媒体不等待模型。

## 7. 第一轮验收

| 场景 | 应有行为 |
| --- | --- |
| 昨天记住桌上，今天杯子已移走，问“现在在哪” | 历史只作线索，无新画面不回答现在仍在桌上 |
| 问“上次记录在哪” | 返回历史时间/来源，无需新视觉推理；界面应支持不启动相机也查询 |
| “上次记住的杯子现在在哪” | 解析历史物品身份 + 当前位置目标，不误分成纯历史 |
| “我想把这个杯子记下来” | 进入记忆流程；多个杯子时先澄清 |
| “别记住，只看看” | 只描述，不写长期库 |
| “我可能放厨房了” | 保存到本轮线索，不成为已确认位置 |
| 新画面中断，旧图仍存在 | 拒绝把旧图作为当前证据；旧任务结果不回写 |
| 新样本上传一半失败 | 不宣布成功，原记忆完整保留 |
| 两件同名蓝杯 | 对象独立，询问要哪件，不按名称直接覆盖 |
| 手机与网页重复发同一保存请求 | request_id 去重，只写一次 |
| 两个账号 | 不能读取或修改对方记录与样本 |
| 应用退出重开/换设备登录 | 长期记录可恢复；旧画面不恢复为当前证据 |

先建立上述可重复用例，再比较改造前后意图准确率、历史/当前混淆率、错误写入次数、同类误认率、响应时间和跨设备恢复结果。目标是任务完成可靠，不以模型自报置信度代替测试。

## 8. 网上可借鉴的案例与来源

以下是架构参考，不是本项目已采用的框架或能力证明。

1. LangGraph 将短期记忆作为会话 state，长期记忆用跨会话 store。可借鉴作用范围和读取时机；视障找物还必须增加视觉证据有效性。https://docs.langchain.com/oss/python/concepts/memory
2. Letta 的 core/in-context 与 archival/out-of-context 分层，历史信息按需检索。可借鉴不把全部历史反复放入上下文；core 不等同于我们按时效划分的“短期视觉记忆”。https://github.com/letta-ai/skills/blob/main/letta/agent-development/references/memory-architecture.md
3. 千问 Function Calling 示例将自然语言请求转换为工具名和参数，由应用执行后回传。可用于意图层，但不能绕过应用的记忆写入和证据校验。https://help.aliyun.com/en/model-studio/qwen-function-calling
4. 千问结构化输出区分 JSON Object 与 JSON Schema；具体模型和地区支持需核对。https://help.aliyun.com/zh/model-studio/qwen-structured-output
5. Supabase 以 Postgres 为核心，提供 Auth、Storage 等能力。https://supabase.com/docs/guides/database/overview
6. 数据表 RLS 和 Storage 授权分别配置，管理密钥不能发给客户端。https://supabase.com/docs/guides/database/postgres/row-level-security 和 https://supabase.com/docs/guides/storage/security/access-control
7. 私有文件通过授权下载或有期限签名 URL 读取。https://supabase.com/docs/guides/storage/serving/downloads

## 9. 推荐实施顺序

1. 先固定完整网页/iOS 共用的意图协议与来源/时间字段；增加可重复验收用例。
2. 完成当前观察和长期事件分层，修复历史/当前误分和过期画面处理。
3. 接入现有千问的独立意图解析请求，保留确定性停止和固定口令降级。
4. 增加 Supabase 登录、表和私有样本存储，迁移并验证实际数据。
5. 安卓接入统一后端与协议，保留本机识别和本地缓存；再按实测决定特征模型和语义检索优化。

无需先重写 iOS UI。现有 iOS 测试工程能复用网页/后台改造，但登录持久化、网络和真机媒体仍需验收。
