"""受控入口的最小进程声明；不读取命令参数、环境或请求内容。"""
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import uuid

CONTEXT_VERSION = 1
HEADER = "X-Relay-Sandbox-Invocation"
EXECUTABLES = {"curl": "/usr/bin/curl", "wget": "/usr/bin/wget", "python": "/usr/bin/python3"}
FIELDS = {"invocationId", "tool", "pid", "parentPid", "processStartTicks", "startedAt", "executable"}


def encode_context(tool):
    """exec后的curl/wget沿用入口PID；启动tick用于区分同命名空间内PID复用。"""
    stat = Path("/proc/self/stat").read_text()
    context = {
        "invocationId": str(uuid.uuid4()), "tool": tool,
        "pid": os.getpid(), "parentPid": os.getppid(),
        "processStartTicks": stat.rsplit(")", 1)[1].split()[19],
        "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "executable": EXECUTABLES[tool],
    }
    return base64.urlsafe_b64encode(json.dumps(context, separators=(",", ":")).encode()).decode()


def decode_context(value):
    """声明来自沙箱客户端，可伪造；仅接受有界固定字段，不能当作内核证明。"""
    if not isinstance(value, str) or len(value) > 2048 or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        raise ValueError("invalid-context")
    raw = base64.b64decode(value, altchars=b"-_", validate=True)
    if len(raw) > 1024:
        raise ValueError("invalid-context")
    context = json.loads(raw)
    if not isinstance(context, dict) or set(context) != FIELDS:
        raise ValueError("invalid-context")
    if not isinstance(context["invocationId"], str) or (str(uuid.UUID(context["invocationId"])) != context["invocationId"] or uuid.UUID(context["invocationId"]).version != 4):
        raise ValueError("invalid-context")
    tool = context["tool"]
    if not isinstance(tool, str) or tool not in EXECUTABLES or context["executable"] != EXECUTABLES[tool]:
        raise ValueError("invalid-context")
    for field, pattern in [("processStartTicks", r"[0-9]{1,20}"),
                           ("startedAt", r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z")]:
        if not isinstance(context[field], str) or not re.fullmatch(pattern, context[field]):
            raise ValueError("invalid-context")
    datetime.fromisoformat(context["startedAt"].replace("Z", "+00:00"))
    for field, minimum in [("pid", 1), ("parentPid", 0)]:
        if type(context[field]) is not int or not minimum <= context[field] <= 2147483647:
            raise ValueError("invalid-context")
    return {**context, "source": "client-reported", "pidNamespace": "container"}


def invocation_header(tool, client_id):
    """元数据读取故障只留下固定缺口，不中断已经选定的代理请求或重放。"""
    try:
        return encode_context(tool)
    except (OSError, ValueError, IndexError):
        import sys
        print(json.dumps({"clientId": client_id, "reason": "process-context-unavailable"}), file=sys.stderr, flush=True)
        return None
