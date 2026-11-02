"""在容器内以无覆盖、无链接方式投放独立诱饵；输出只含最小结果。"""
import errno
import json
import os
import sys

DIRECTORY = "/home/node/.config/relay-sandbox/decoys"
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def directory_fd(path):
    """逐层固定目录句柄，拒绝链接和非目录祖先，不依赖先检查再字符串写入。"""
    current = os.open("/", FLAGS)
    try:
        for part in path.strip("/").split("/"):
            try:
                os.mkdir(part, 0o700, dir_fd=current)
            except FileExistsError:
                pass
            next_fd = os.open(part, FLAGS, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def install(entry):
    """O_EXCL 保证已有文件及最终路径链接不会被覆盖。"""
    result = {"id": entry["id"], "path": entry["path"], "status": "skipped"}
    if os.path.dirname(entry["path"]) != DIRECTORY:
        raise ValueError("invalid target")
    directory = None
    try:
        directory = directory_fd(DIRECTORY)
        fd = os.open(os.path.basename(entry["path"]),
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(entry["content"])
        result["status"] = "installed"
    except OSError as error:
        # 冲突仅跳过，错误原因使用固定代码，绝不打印请求载荷或文件内容。
        if error.errno == errno.EEXIST:
            result["reason"] = "existing-path"
        elif error.errno in (errno.ELOOP, errno.ENOTDIR):
            result["reason"] = "symlink-or-nondirectory"
        elif error.errno in (errno.EACCES, errno.EPERM):
            result["reason"] = "permission-denied"
        else:
            raise
    finally:
        if directory is not None:
            os.close(directory)
    return result


def main():
    """仅消费宿主生成的投放计划，不更改环境变量或默认凭据文件。"""
    entries = json.loads(sys.argv[1])
    if os.getuid() != 1000:
        raise ValueError("invalid uid")
    print(json.dumps([install(entry) for entry in entries]))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 避免 traceback 携带调用参数、诱饵内容或其他容器数据。
        print("诱饵安装失败", file=sys.stderr)
        sys.exit(1)
