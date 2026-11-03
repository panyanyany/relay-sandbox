"""只写最小命中元数据；不记录flow、请求片段或异常中的流量内容。"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import uuid
from urllib.parse import quote
from mitmproxy import http

# mitmproxy插件加载器不保证将脚本目录加入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from traffic_context import HEADER, decode_context

spec = importlib.util.spec_from_file_location("traffic_match", "/opt/relay/traffic-match.py")
matcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matcher)
entries = json.loads(Path("/private/manifest.json").read_text())["entries"]
MAX_BYTES = 1048576
MAX_LOG = 1048576
MAX_FILES = 3


def append(name, event):
    """单写者轮转；两个证据流合计最多6MiB，不保存原始flow。"""
    path = Path("/evidence") / name
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    if path.exists() and path.stat().st_size + len(data) > MAX_LOG:
        for index in range(MAX_FILES - 1, 0, -1):
            source = path if index == 1 else Path(str(path) + f".{index - 1}")
            target = Path(str(path) + f".{index}")
            if source.exists():
                source.replace(target)
    with path.open("ab") as output:
        os.chmod(path, 0o600)
        output.write(data)


def safe_host(host):
    """目标也可能含诱饵；整字段替换，不保存原值或编码片段。"""
    if not re.fullmatch(r"[A-Za-z0-9._:\[\]-]{1,253}", host):
        return "redacted.invalid"
    for entry in entries:
        raw = entry["value"].encode()
        forms = [entry["value"], quote(entry["value"], safe=""),
                 base64.b64encode(raw).decode(), base64.urlsafe_b64encode(raw).decode()]
        if any(form.rstrip("=").lower() in host.lower() for form in forms):
            return "redacted.invalid"
    return host


def observe(data, flow, location, encoding="identity"):
    result = matcher.match_content(data, entries, safe_host(flow.request.host),
                                   flow.request.port, location, content_encoding=encoding)
    for event in result["events"]:
        if flow.metadata.get("relay-invocation"):
            event["invocation"] = flow.metadata["relay-invocation"]
        append("events.jsonl", event)
    for gap in result["gaps"]:
        append("gaps.jsonl", gap)


def requestheaders(flow: http.HTTPFlow):
    """头与目标仅在内存匹配；不保存完整URL或字段名/值。"""
    # 错误示范：保留内部头会把进程元数据发送到外部；必须先删除再观察和转发。
    values = flow.request.headers.get_all(HEADER)
    if values:
        del flow.request.headers[HEADER]
        try:
            if len(values) != 1:
                raise ValueError("duplicate-context")
            context = decode_context(values[0])
            flow.metadata["relay-invocation"] = {**context, "requestId": str(uuid.uuid4())}
        except (ValueError, TypeError, KeyError):
            append("gaps.jsonl", {"reason": "invocation-context-invalid", "location": "header"})
    observe(flow.request.pretty_url, flow, "target")
    for _name, value in flow.request.headers.fields:
        observe(value, flow, "header")


def request(flow: http.HTTPFlow):
    """streamed内容不存储也不阻断；未知压缩明确标记缺口。"""
    if flow.request.raw_content is None:
        append("gaps.jsonl", {"reason": "size-limit", "location": "body"})
    else:
        observe(flow.request.raw_content, flow, "body", flow.request.headers.get("content-encoding", "identity"))
