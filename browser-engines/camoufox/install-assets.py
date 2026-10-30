"""构建期流式下载和磁盘解包官方固定资源，避免把约1.3GB ZIP读入内存。"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parent
release = json.loads((root / "assets.json").read_text())
pin = json.loads((root / "node_modules/camoufox/dist/data-files/browser-pin.json").read_text())
for key in ("tag", "repo", "version", "build"):
    if pin[key] != release[key]:
        raise RuntimeError("启动器与固定浏览器资源不配对：" + key)
arch = platform.machine()
asset = release["assets"][arch]
asset_arch = {"x86_64": "x86_64", "aarch64": "arm64"}[arch]
name = "camoufox-" + release["version"] + "-" + release["build"] + "-lin." + asset_arch + ".zip"
url = "https://github.com/" + release["repo"] + "/releases/download/" + release["tag"] + "/" + name
cache = Path(os.environ["XDG_CACHE_HOME"]) / "camoufox"
relative = "browsers/official/" + release["version"] + "-" + release["build"] + "-" + asset["sha256"][:8]
target = cache / relative
cache.mkdir(parents=True, exist_ok=True)
reserve = 3 * 1024**3
if shutil.disk_usage(cache).free < asset["size"] + reserve:
    raise RuntimeError("磁盘不足以安全下载资源")
if target.exists():
    raise RuntimeError("拒绝覆盖已有资源；构建必须使用干净目录")

with tempfile.TemporaryDirectory(prefix="role-camoufox-") as temporary:
    archive = Path(temporary) / "browser.zip"
    digest, size = hashlib.sha256(), 0
    request = urllib.request.Request(url, headers={"User-Agent": "role-workflow-build"})
    print("流式下载固定资源：" + name, flush=True)
    with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > asset["size"]:
                raise RuntimeError("资源超过固定大小")
            digest.update(chunk)
            output.write(chunk)
    if size != asset["size"] or digest.hexdigest() != asset["sha256"]:
        raise RuntimeError("浏览器资源大小或SHA256不符")
    print("官方SHA256与固定大小核对通过", flush=True)
    try:
        with zipfile.ZipFile(archive) as package:
            entries = package.infolist()
            unpacked = sum(entry.file_size for entry in entries)
            # 解包和镜像导出各留一份空间，另保留3GiB宿主余量；不靠清理生产让路。
            free = shutil.disk_usage(cache).free
            if free < unpacked + reserve or free + size < unpacked * 2 + reserve:
                raise RuntimeError("磁盘不足以安全解包和导出浏览器镜像")
            for entry in entries:
                destination = (target / entry.filename).resolve()
                if not destination.is_relative_to(target.resolve()):
                    raise RuntimeError("ZIP含越界路径")
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                destination.chmod(0o755)
        metadata = {key: release[key] for key in ("version", "build", "interface")}
        metadata.update(prerelease=True, sha256=asset["sha256"], created_at=release["publishedAt"])
        (target / "version.json").write_text(json.dumps(metadata))
        (cache / "config.json").write_text(json.dumps({"active_version": relative}))
        (cache / ".0.5_FLAG").touch()
        print("磁盘解包完成：" + relative, flush=True)
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
