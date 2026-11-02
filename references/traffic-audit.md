# 通信审计代理的兼容边界

核对日期：2026-11-02。以下为官方资料观察，不代表项目已经实现代理或通过验收。

## TLS 证书与透传

[mitmproxy 证书说明](https://docs.mitmproxy.org/stable/concepts/certificates/)要求客户端信任审计 CA；使用独立信任库或证书固定的客户端可能不兼容。

[官方 tls_passthrough.py 示例](https://github.com/mitmproxy/mitmproxy/blob/main/examples/contrib/tls_passthrough.py)明确展示：不信任代理的第一次请求发生证书错误，后续请求才通过免解密连接成功。源码在 tls_failed_client 记录失败，后续 ClientHello 决定是否透传。示例中的 --insecure 只说明演示过程，本项目不以关闭证书验证实现兼容。

适配判断：失败后透传不能保证任意安装命令无感成功；不能假定客户端会重试，也不能未经语义判断重放任意 HTTP 请求。若要求兼容优先，需要事先限定可解密范围，或由用户接受首次失败的可见性。具体接入机制及工具范围须经实际安装工具验收。

## 证据限制

代理中观察到诱饵，仅证明内容到达该观察点；不能单凭此声称目标已收到或操作恶意。免解密及绕过代理的通信没有内容匹配证据。加密、拆分和未支持的变换可能漏检；无命中不表示无外传。
