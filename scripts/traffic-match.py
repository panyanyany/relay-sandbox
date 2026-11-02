"""有界的一层诱饵匹配；返回元数据，不输出或持久化请求内容。"""
import base64
from datetime import datetime, timezone
import re

_LOCATIONS = {"target", "header", "body"}
_HOST = re.compile(r"^[A-Za-z0-9._:\[\]-]{1,253}$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def match_content(content, entries, host, port, location, max_bytes=1048576,
                  time=None, content_encoding="identity"):
    """只检查上限内数据；调用方负责已验证的有界解压，不自动解码嵌套表示。"""
    if location not in _LOCATIONS or not isinstance(host, str) or not _HOST.fullmatch(host):
        raise ValueError("不支持的观察位置或目标主机")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("目标端口无效")
    if not isinstance(max_bytes, int) or not 1 <= max_bytes <= 16 * 1048576:
        raise ValueError("匹配上限必须在1字节至16MiB之间")
    if not isinstance(entries, list) or len(entries) > 128:
        raise ValueError("诱饵清单超过容量")
    result = {"events": [], "gaps": []}
    if content_encoding not in (None, "", "identity"):
        result["gaps"].append({"reason": "unsupported-content-encoding", "location": location})
        return result
    # 字符串先截限再编码，避免为超大Unicode字段额外复制全部内容。
    oversized = len(content) > max_bytes
    if isinstance(content, str):
        data = content[:max_bytes].encode("utf-8")
    elif isinstance(content, bytes):
        data = content[:max_bytes]
    else:
        raise TypeError("匹配输入必须是字节或字符串")
    oversized = oversized or len(data) > max_bytes
    data = data[:max_bytes]
    if oversized:
        result["gaps"].append({"reason": "size-limit", "location": location})
    timestamp = time or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    seen = set()
    for entry in entries:
        decoy_id, value = entry.get("id"), entry.get("value")
        if not isinstance(decoy_id, str) or not _ID.fullmatch(decoy_id):
            raise ValueError("诱饵编号无效")
        if not isinstance(value, str) or not 1 <= len(value) <= 4096:
            raise ValueError("诱饵值长度无效")
        raw = value.encode("utf-8")
        # 仅匹配原值各字节的原文/percent形式，且命中本身必须含编码。
        # 避免同一字段别处的%20把普通原值误记成percent命中。
        percent_match = False
        if b"%" in data:
            alternatives = []
            for byte in raw:
                hexadecimal = f"{byte:02X}"
                hex_pattern = "".join(f"[{char.lower()}{char}]" if char.isalpha() else char for char in hexadecimal)
                alternatives.append(b"(?:" + re.escape(bytes([byte])) + b"|%" + hex_pattern.encode("ascii") + b")")
            percent_match = any(b"%" in match.group() for match in re.finditer(b"".join(alternatives), data))
        standard = base64.b64encode(raw)
        urlsafe = base64.urlsafe_b64encode(raw)
        matches = [
            ("raw", raw in data),
            ("url-percent", percent_match),
            ("base64", standard in data or standard.rstrip(b"=") in data),
            ("base64url", urlsafe in data or urlsafe.rstrip(b"=") in data),
        ]
        for encoding, matched in matches:
            if matched and (decoy_id, encoding) not in seen:
                seen.add((decoy_id, encoding))
                result["events"].append({"time": timestamp, "host": host, "port": port,
                                         "decoyId": decoy_id, "encoding": encoding,
                                         "location": location})
    return result
