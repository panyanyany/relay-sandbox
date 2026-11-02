"""安装独立公共工具；所有路径都从保留根的目录描述符逐级打开。"""
import base64
import json
import os
import re
import stat
import sys

NAMES = {"traffic-client.py", "traffic-python.py", "clients.json", "ca.pem"}
LIMIT = 131072


def install(payload):
    """完整验证后才写入；目标存在即失败，不覆盖或合并。"""
    runtime = payload.get("runtimeId", "")
    files = payload.get("files", [])
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", runtime):
        raise ValueError("invalid-runtime")
    if not isinstance(files, list) or not 1 <= len(files) <= 4:
        raise ValueError("invalid-files")
    decoded, names = [], set()
    for item in files:
        name, mode = item.get("name"), item.get("mode")
        if name not in NAMES or name in names or mode not in (0o644, 0o755):
            raise ValueError("invalid-file")
        content = item.get("content", "")
        if not isinstance(content, str) or len(content) > (LIMIT + 2) // 3 * 4:
            raise ValueError("size-limit")
        data = base64.b64decode(content, validate=True)
        if len(data) > LIMIT:
            raise ValueError("size-limit")
        names.add(name)
        decoded.append((name, mode, data))
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in ["opt", "relay-sandbox", "audit", runtime]:
            try:
                os.mkdir(component, 0o755, dir_fd=directory)
            except FileExistsError:
                pass
            try:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            except OSError:
                raise ValueError("unsafe-parent") from None
            info = os.fstat(child)
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                os.close(child)
                raise ValueError("unsafe-parent")
            os.close(directory)
            directory = child
        # 预检保证普通重复调用不留下半套安装；写入仍独占以防竞态。
        for name, _mode, _data in decoded:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ValueError("existing-file")
        for name, mode, data in decoded:
            try:
                output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
            except FileExistsError:
                raise ValueError("existing-file") from None
            with os.fdopen(output, "wb") as target:
                os.fchmod(target.fileno(), mode)
                target.write(data)
    finally:
        os.close(directory)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 710000:
            raise ValueError("size-limit")
        install(json.loads(sys.argv[1]))
        print(json.dumps({"ok": True}))
    except ValueError as error:
        reason = str(error) if str(error) in {"invalid-runtime", "invalid-files", "invalid-file", "size-limit", "unsafe-parent", "existing-file"} else "invalid-input"
        print(json.dumps({"ok": False, "reason": reason}))
        sys.exit(1)
    except Exception:
        # 不把系统异常、原始参数或文件内容写入日志。
        print(json.dumps({"ok": False, "reason": "installation-io-error"}))
        sys.exit(1)
