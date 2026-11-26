#!/usr/bin/env python3
# 重写 HNP 的内置 ZIP 条目属性：目录 0755、文件 0644。
#
# 为什么需要：本机 /tmp 是 setgid（2770），zip 会把目录的 2755（setgid）原样存进
# HNP；安装器解包后再 chmod 2755 可能因权限/属组失败，表现为 9568407。
# 已装可用的 aria2.hnp 里文件是 0644、目录无特殊位 —— 这里对齐它。
import os
import sys
import zipfile

path = sys.argv[1]
temporary = path + ".attrs.tmp"

with zipfile.ZipFile(path, "r") as source:
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            payload = source.read(info.filename)
            entry = zipfile.ZipInfo(info.filename, info.date_time)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3  # Unix
            if info.is_dir():
                entry.external_attr = (0o40755 << 16) | 0x10
            else:
                entry.external_attr = 0o100644 << 16
            target.writestr(entry, payload)

os.replace(temporary, path)
print("[hnp] attrs normalized:", path)