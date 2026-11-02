#!/usr/bin/env python3
"""独立显式客户端入口：只对已验证组合接入代理，其他调用原样执行。"""
import json
import os
import re
import socket
import subprocess
import sys
from urllib.parse import urlsplit

BINARIES = {"curl": "/usr/bin/curl", "wget": "/usr/bin/wget"}
VERSIONS = {"curl": "7.88.1", "wget": "1.21.3"}
SWITCHES = {"curl": {"--fail", "--silent", "--show-error"}, "wget": {"--quiet"}}
VALUES = {"curl": {"--max-time", "--data-binary", "--header", "--request", "--output"},
          "wget": {"--tries", "--timeout", "--output-document", "--post-data", "--header"}}


def arguments_supported(tool, args):
    """限制为单个HTTP(S)请求形态，不解析配置文件或猜测未知参数语义。"""
    expected = "--disable" if tool == "curl" else "--no-config"
    if not args or args[0] != expected:
        return False
    index, urls = 1, 0
    while index < len(args):
        arg = args[index]
        if arg in SWITCHES[tool]:
            index += 1
        elif arg in VALUES[tool] and index + 1 < len(args):
            index += 2
        elif arg.startswith(("https://", "http://")):
            parsed = urlsplit(arg)
            if not parsed.hostname or parsed.username or parsed.password:
                return False
            urls += 1
            index += 1
        else:
            return False
    return urls == 1


def classify(config, tool, args):
    """唯一分类器在请求前决定，不因请求失败自动直连重放。"""
    clients = [c for c in config.get("clients", []) if c.get("tool") == tool]
    prefix = [tool, "--disable" if tool == "curl" else "--no-config"]
    client = next((c for c in clients if c.get("version") == VERSIONS[tool]
                   and c.get("trustStore") == "explicit-ca-file"
                   and c.get("invocation") == prefix and not c.get("library")),
                  clients[0] if clients else {})
    identifier = client.get("id", tool)
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", identifier):
        identifier = tool
    if not clients:
        return identifier, "unconfigured-client"
    try:
        probe = subprocess.run([BINARIES[tool], "--version"], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return identifier, "version-unavailable"
    lines = probe.stdout.splitlines()
    if probe.returncode != 0 or not lines:
        return identifier, "version-unavailable"
    version = re.search(r"(?:curl|GNU Wget) ([0-9.]+)", lines[0])
    if not version or client.get("version") != version[1] or version[1] != VERSIONS[tool]:
        return identifier, "unverified-version"
    if client.get("trustStore") != "explicit-ca-file" or client.get("invocation") != prefix or client.get("library"):
        return identifier, "unverified-configuration"
    if not arguments_supported(tool, args):
        return identifier, "unsupported-arguments"
    if any(os.environ.get(key) for key in ("CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy")):
        return identifier, "custom-environment"
    proxy = urlsplit(config["endpoint"])
    if proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port or not os.path.isfile(config["caPath"]):
        return identifier, "invalid-proxy-configuration"
    try:
        with socket.create_connection((proxy.hostname, proxy.port), timeout=0.3):
            pass
    except OSError:
        return identifier, "proxy-unavailable"
    return identifier, None


def main():
    """缺口只写安全编号和固定原因；原始工具负责保留正常错误及退出码。"""
    if len(sys.argv) < 4 or sys.argv[2] not in BINARIES:
        raise SystemExit("需要公开配置路径、curl/wget及原始参数")
    path, tool, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    try:
        with open(path, encoding="utf8") as source:
            config = json.load(source)
        if not isinstance(config, dict) or config.get("schemaVersion") != 1 or not isinstance(config.get("clients"), list) or not all(isinstance(client, dict) for client in config["clients"]):
            raise ValueError("公开审计配置格式不支持")
        if not isinstance(config.get("endpoint"), str) or not isinstance(config.get("caPath"), str):
            raise ValueError("公开审计配置缺少代理或CA")
    except (OSError, ValueError):
        config = None
    if config is None:
        identifier, gap = tool, "catalog-unavailable"
    else:
        try:
            identifier, gap = classify(config, tool, args)
        except ValueError:
            identifier, gap = tool, "invalid-proxy-configuration"
    if gap:
        print(json.dumps({"clientId": identifier, "reason": gap}, separators=(",", ":")), file=sys.stderr, flush=True)
        os.execv(BINARIES[tool], [tool, *args])
    if tool == "curl":
        injected = ["--noproxy", "", "--proxy", config["endpoint"], "--cacert", config["caPath"]]
    else:
        injected = ["--execute=use_proxy=yes", "--execute=http_proxy=" + config["endpoint"], "--execute=https_proxy=" + config["endpoint"], "--ca-certificate=" + config["caPath"]]
    os.execv(BINARIES[tool], [tool, args[0], *injected, *args[1:]])


if __name__ == "__main__":
    main()
