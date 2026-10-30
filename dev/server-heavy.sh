#!/bin/sh
# 只在服务器执行。所有候选构建／测试共用锁，限制真正执行任务的容器，而非仅限制docker客户端。
set -eu
mode=${1:?用法：server-heavy.sh build|run 参数};shift
case "$mode" in build|run) ;; *) echo '仅支持 build 或 run' >&2;exit 2;; esac
limit=${ROLE_HEAVY_MEMORY_MIB:-640}
case "$limit" in *[!0-9]*|'') echo '内存上限无效' >&2;exit 2;; esac
test "$limit" -ge 128 && test "$limit" -le 896 || { echo '上限必须在128–896MiB' >&2;exit 2; }
exec 9>/var/lock/role-workflow-heavy.lock
flock -n 9 || { echo '已有候选构建或界面验收在运行，不并发执行' >&2;exit 75; }
available=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
test "$available" -ge "$((limit+1024))" || { echo "可用内存${available}MiB，不足以保留1GiB宿主余量" >&2;exit 75; }
free_kib=$(df -Pk /var/lib/docker | awk 'NR==2{print $4}')
test "$free_kib" -ge 3145728 || { echo 'Docker磁盘不足3GiB，不启动重任务' >&2;exit 75; }
builder=role-workflow-limited
job=role-workflow-heavy-$$
cleanup(){ if test "$mode" = build;then docker buildx stop "$builder" >/dev/null 2>&1 || true;else docker rm -f "$job" >/dev/null 2>&1 || true;fi; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
if test "$mode" = build;then
 test "$limit" = 640 || { echo '构建器固定640MiB' >&2;exit 2; }
 for arg in "$@";do case "$arg" in --builder|--builder=*|--push|--memory*|--cpu*|--load|--output*|-o) echo '构建器、输出和资源限制由入口统一设置' >&2;exit 2;; esac;done
 if ! docker buildx inspect "$builder" >/dev/null 2>&1;then
  config=$(mktemp /tmp/role-workflow-buildkit.XXXXXX)
  printf '[worker.oci]\n  max-parallelism = 1\n' > "$config"
  docker buildx create --name "$builder" --driver docker-container --driver-opt memory=640m,memory-swap=640m,cpu-period=100000,cpu-quota=100000,restart-policy=no --buildkitd-config "$config"
  rm -f "$config"
 fi
 docker buildx inspect "$builder" --bootstrap >/dev/null
 docker inspect buildx_buildkit_role-workflow-limited0 | python3 -c 'import sys,json;d=json.load(sys.stdin)[0];h=d["HostConfig"];assert h["Memory"]==671088640 and h["MemorySwap"]==671088640 and h["CpuQuota"]==100000 and h["CpuPeriod"]==100000,"构建器真实资源限制不符";print("BuildKit限制核对通过：640MiB，无额外swap，单核")'
 timeout --signal=TERM --kill-after=30s 1200s docker buildx build --builder "$builder" --load "$@"
else
 for arg in "$@";do case "$arg" in --memory*|--cpu*|--cgroup*|--pids-limit*|--name*|--oom*|--privileged|--pid|--pid=*|--restart*|--detach|-d|--rm) echo '任务名称、后台模式和资源限制由入口统一设置' >&2;exit 2;; esac;done
 timeout --signal=TERM --kill-after=30s 1200s docker run --name "$job" --rm --memory "${limit}m" --memory-swap "${limit}m" --cpus 1 --pids-limit 256 -e NODE_OPTIONS=--max-old-space-size=512 "$@"
fi
