# 同频隐私说明

同频不设置服务器、不含广告或统计 SDK、不收集浏览历史。

插件观察 X 页面成功创建帖子/转发的响应，只对用户设置的账号和类型生成任务。为了判断转发操作属于谁，可能读取 X 页面的当前账号个人主页链接。它不读取或储存 X 密码、Cookie、私信或交易资料。

币安广场 API Key、配置、待发布正文与媒体地址、同步记录以及去重 ID 保存在当前 Chrome 的 chrome.storage.local 中，不使用 chrome.storage.sync。local 存储对网页内容脚本禁用访问，只有扩展可信页面可访问。Chrome 本地扩展存储不是硬件加密保险箱；拥有同一系统账号/Chrome 配置文件控制权的人仍可能访问。

网络传输只涉及：从 X 媒体 CDN 下载当前同步帖的附件；将 API Key 放在 HTTPS 请求头发送给 www.binance.com 的官方广场接口；将附件上传到该接口返回的受信任签名存储地址。上传文件的 PUT 请求不携带广场 API Key。插件不向其他应用或中转服务器传输密钥。

权限用途：storage 保存配置与去重；alarms 恢复队列；offscreen 持续处理媒体 Blob；X 页面脚本观察新帖成功结果；www.binance.com 发布；pbs.twimg.com/video.twimg.com 下载附件；amazonaws.com/bnbstatic.com 上传币安接口签发的媒体文件。

「移除 API」删除本地凭据并关闭自动同步，不删除帖子；卸载扩展会删除本地数据，不会删除 X 或广场已经发布的内容。导出偏好不包含 API，但包含填写的 X 用户名。分享插件文件不会附带当前 Chrome 中的设置或凭据。

更新时间：2026-11-14。
