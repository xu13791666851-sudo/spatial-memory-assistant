# GitHub 参考与复用范围

本阶段参考 [supabase-kt](https://github.com/supabase/supabase-kt) 客户端实现，核对一次性邮件登录、刷新登录状态和私有文件访问的请求方式。安卓项目已经使用 OkHttp 和 Room，因此沿用现有依赖完成最小接入，避免为了登录再引入完整界面或另一套数据管理方式。

核对的源码位于 Supabase 官方组织的 [supabase/supabase-kt](https://github.com/supabase/supabase-kt)：

- [邮件 OTP 参数](https://github.com/supabase/supabase-kt/blob/master/Auth/src/commonMain/kotlin/io/github/jan/supabase/auth/providers/builtin/OTP.kt)，读取版本 SHA `ecc778d1a88e3795c704571f4e36f0a6c8dcf487`。
- [登录与刷新实现](https://github.com/supabase/supabase-kt/blob/master/Auth/src/commonMain/kotlin/io/github/jan/supabase/auth/AuthImpl.kt)，读取版本 SHA `6561ce1564f7c104ecf139b4de58bbdafb463f84`。
- [私有文件操作](https://github.com/supabase/supabase-kt/blob/master/Storage/src/commonMain/kotlin/io/github/jan/supabase/storage/BucketApiImpl.kt)，读取版本 SHA `7388e8b4e6466993cded9447469f9c549856d81f`。

上游为 MIT 许可证，版权信息为 2025 Jan Tennert。这里只借鉴协议和边界处理，没有复制上游页面、样例账号、业务数据或整个 SDK。具体请求仍以 [Supabase 官方登录文档](https://supabase.com/docs/guides/auth/auth-email-passwordless) 和 [私有文件权限文档](https://supabase.com/docs/guides/storage/security/access-control) 为依据。

没有借用来历不明的“完整找物应用”，因为这会引入与现有统一找物核心不一致的流程。项目自己的同名物品、参考照片和位置历史，需要由本项目的数据检查验证，不能通过套用示例证明正确。
