#!/usr/bin/env python3
"""明确的urllib.request入口，只使用局部代理与SSLContext。"""
import argparse
import json
import os
import platform
import re
import socket
import shutil
import ssl
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener


def classify(config, args):
    """请求开始前选择审计或标准直通；运行时业务错误不触发重放。"""
    if config is None:
        return "python", "catalog-unavailable"
    clients = [client for client in config["clients"] if client.get("tool") == "python"]
    matched = [client for client in clients if client.get("version") == "3.11.2"
               and client.get("library") == "urllib.request@3.11.2"
               and client.get("trustStore") == "explicit-ca-file"
               and client.get("invocation") == ["python", "urllib.request"]]
    client = matched[0] if matched else (clients[0] if clients else {})
    identifier = client.get("id", "python")
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", identifier):
        identifier = "python"
    if platform.python_version() != "3.11.2" or not matched:
        return identifier, "unverified-configuration"
    if args.ca_file:
        return identifier, "custom-trust"
    if any(os.environ.get(key) for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy")):
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
    """仅暴露HTTP请求选项，不执行或包装任意用户Python脚本。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog")
    parser.add_argument("url")
    parser.add_argument("--method", default="GET", choices=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    parser.add_argument("--data")
    parser.add_argument("--ca-file")
    args = parser.parse_args()
    if urlsplit(args.url).scheme not in ("http", "https"):
        parser.error("只支持HTTP(S)请求")
    try:
        with open(args.catalog, encoding="utf8") as source:
            config = json.load(source)
        if not isinstance(config, dict) or config.get("schemaVersion") != 1 or not isinstance(config.get("clients"), list) or not all(isinstance(client, dict) for client in config["clients"]):
            raise ValueError("公开配置格式不支持")
        if not isinstance(config.get("endpoint"), str) or not isinstance(config.get("caPath"), str):
            raise ValueError("公开配置缺少代理或CA")
    except (OSError, ValueError):
        config = None
    try:
        identifier, gap = classify(config, args)
    except ValueError:
        identifier, gap = "python", "invalid-proxy-configuration"
    if gap:
        print(json.dumps({"clientId": identifier, "reason": gap}, separators=(",", ":")), file=sys.stderr, flush=True)
    # 原始直通沿用标准信任环境；审计仅信任公CA，上游验证由可信代理执行。
    if not gap:
        try:
            context = ssl.create_default_context(cafile=config["caPath"])
        except (OSError, ssl.SSLError):
            gap = "ca-unavailable"
            print(json.dumps({"clientId": identifier, "reason": gap}, separators=(",", ":")), file=sys.stderr, flush=True)
    if gap:
        context = ssl.create_default_context(cafile=args.ca_file)
    proxy = ProxyHandler() if gap else ProxyHandler({"http": config["endpoint"], "https": config["endpoint"]})
    opener = build_opener(proxy, HTTPSHandler(context=context))
    request = Request(args.url, data=args.data.encode() if args.data is not None else None, method=args.method)
    with opener.open(request, timeout=8) as response:
        shutil.copyfileobj(response, sys.stdout.buffer, length=65536)


if __name__ == "__main__":
    main()
