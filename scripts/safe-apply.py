import os
import sys
import json
import hashlib
import stat
from pathlib import Path

# 所有父目录通过目录句柄打开，符号链接祖先直接报错。
def parent_fd(root_fd, path, create=False):
    parts = path.split('/')
    if path.startswith('/') or any(p in ('', '.', '..') for p in parts) or parts[0] == '.git':
        raise ValueError('不安全的交付路径')
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise

# 通过打开句柄核对实际文件，避免摘要检查跟随链接。
def inspect(fd, name):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None, None
    if stat.S_ISDIR(info.st_mode):
        return {'hash': hashlib.sha256(b'').hexdigest(), 'mode': stat.S_IMODE(info.st_mode), 'type': 'directory'}, None
    if stat.S_ISLNK(info.st_mode):
        data = os.readlink(name, dir_fd=fd).encode()
        kind = 'symlink'
    elif stat.S_ISREG(info.st_mode):
        stream = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        with os.fdopen(stream, 'rb') as f:
            data = f.read()
        kind = 'file'
    else:
        raise ValueError('目标不是普通文件或符号链接')
    return {'hash': hashlib.sha256(data).hexdigest(), 'mode': stat.S_IMODE(info.st_mode), 'type': kind}, data

payload = json.load(sys.stdin)
root = os.open(payload['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
source = os.open(payload['source'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
backup = Path(payload['backup'])

# 每次写入前同步备份和计划，崩溃后可区分待应用、已应用及用户再次修改。
def record(event):
    with (backup / 'applied.jsonl').open('a') as log:
        log.write(json.dumps(event) + '\n')
        log.flush()
        os.fsync(log.fileno())

directory_modes = []
try:
    for change in payload['plan']['changes']:
        path = change['path']
        fd, name = parent_fd(root, path, create=change['kind'] != 'delete')
        try:
            current, data = inspect(fd, name)
            expected = change.get('before')
            if (current is None) != (expected is None) or (current and any(current[k] != expected[k] for k in current)):
                raise ValueError('应用时目标已变化: ' + path)
            if data is not None:
                target = backup / 'files' / path
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('wb') as saved:
                    saved.write(data)
                    saved.flush()
                    os.fsync(saved.fileno())
            record({'stage': 'prepared', 'change': change})
            after = change.get('after')
            if after is None:
                if current['type'] == 'directory':
                    os.rmdir(name, dir_fd=fd)
                else:
                    os.unlink(name, dir_fd=fd)
            elif after['type'] == 'directory':
                if current and current['type'] != 'directory':
                    os.unlink(name, dir_fd=fd)
                if not current or current['type'] != 'directory':
                    os.mkdir(name, 0o755, dir_fd=fd)
                directory_modes.append((path, after['mode']))
            else:
                if current and current['type'] == 'directory':
                    os.rmdir(name, dir_fd=fd)
                temp = '.relay-' + os.urandom(12).hex()
                if after['type'] == 'symlink':
                    if hashlib.sha256(after['link'].encode()).hexdigest() != after['hash']:
                        raise ValueError('候选链接摘要错误')
                    os.symlink(after['link'], temp, dir_fd=fd)
                else:
                    srcfd, srcname = parent_fd(source, path)
                    try:
                        actual, content = inspect(srcfd, srcname)
                        if actual is None or any(actual[k] != after[k] for k in actual):
                            raise ValueError('候选产物已变化: ' + path)
                    finally:
                        os.close(srcfd)
                    stream = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, after['mode'], dir_fd=fd)
                    with os.fdopen(stream, 'wb') as f:
                        f.write(content)
                        f.flush()
                        os.fsync(f.fileno())
                    os.chmod(temp, after['mode'], dir_fd=fd, follow_symlinks=False)
                os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
            record({'stage': 'applied', 'path': path, 'kind': change['kind']})
        finally:
            os.close(fd)
    # 最后恢复目录权限，避免只读目录阻碍本轮后代写入。
    for path, mode in reversed(directory_modes):
        fd, name = parent_fd(root, path)
        try:
            os.chmod(name, mode, dir_fd=fd, follow_symlinks=False)
        finally:
            os.close(fd)
finally:
    os.close(root)
    os.close(source)
