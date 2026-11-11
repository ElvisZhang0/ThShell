import type {
  DockerComposeProject,
  DockerContainer,
  DockerContainerDetail,
  DockerDfRow,
  DockerImage,
  DockerNetwork,
  DockerOverview,
  DockerProbe,
  DockerStats,
  DockerVolume
} from '../types'
import type { ExecFn } from './metrics'

/**
 * Docker 管理（容器页）。
 *
 * 设计取舍：
 * 1. 全部走 `docker ... --format '{{json .}}'`，一行一个 JSON —— 比解析表格稳定得多，
 *    表格的列宽会随内容变，IMAGE/COMMAND 里还可能带空格。
 * 2. 不做 docker API（/var/run/docker.sock）直连：那需要另开一条 socket 通道，
 *    而 SSH 已经在手边，exec 一条命令的成本可以忽略。远程开了 TLS 或 socket 权限特殊时也不用管。
 * 3. 所有用户输入（容器 id / 镜像名 / 卷名）必须过 `sh()` 单引号转义，避免命令注入。
 */

/** POSIX 单引号转义：' -> '\'' ，这是 sh 里唯一可靠的写法 */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 容器/镜像标识白名单：id、名称、repo:tag、sha256:… 都落在这个范围内 */
function safeRef(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(value)) {
    throw new Error(`非法的 Docker 标识：${value}`)
  }
  return value
}

function jsonLines<T>(raw: string): T[] {
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      out.push(JSON.parse(text) as T)
    } catch {
      /* 被截断的行（大输出时 ssh 分片）直接丢，下一次轮询会补上 */
    }
  }
  return out
}

/**
 * 探测：一次 exec 拿 docker 是否可用 + 版本 + compose。
 * 不可用时把 stderr 原样带回，界面据此区分「没装」和「没权限」——
 * 这两种在运维现场是完全不同的处理方式。
 */
export async function probeDocker(exec: ExecFn): Promise<DockerProbe> {
  const script = [
    'export LC_ALL=C',
    'echo @@BIN@@; (command -v docker 2>/dev/null || echo NONE)',
    'echo @@VER@@; (docker --version 2>&1 || echo NONE)',
    'echo @@COMPOSE@@; (docker compose version --short 2>/dev/null || docker-compose version --short 2>/dev/null || echo NONE)',
    "echo @@INFO@@; (docker info --format '{{json .}}' 2>&1 || echo FAILED)"
  ].join('; ')

  const result = await exec(script)
  const segments = result.stdout.split('@@')
  const pick = (tag: string): string => {
    const idx = segments.indexOf(tag)
    return idx >= 0 ? (segments[idx + 1] ?? '').trim() : ''
  }

  const bin = pick('BIN')
  const version = pick('VER').replace(/^NONE$/, '')
  if (!bin || bin === 'NONE') {
    return { available: false, version: '', compose: '', serverVersion: '', error: '' }
  }

  const infoRaw = pick('INFO')
  let serverVersion = ''
  let error = ''
  if (infoRaw && infoRaw !== 'FAILED' && infoRaw.startsWith('{')) {
    try {
      serverVersion = String(JSON.parse(infoRaw).ServerVersion ?? '')
    } catch {
      /* 解析不了就当没拿到，下面的 error 分支会兜 */
    }
  } else {
    // 典型两种：permission denied（不在 docker 组）、Cannot connect（daemon 没起）
    error = infoRaw.replace(/^FAILED$/, '').split('\n').slice(0, 3).join(' ').trim()
  }

  return {
    available: true,
    version,
    compose: pick('COMPOSE').replace(/^NONE$/, ''),
    serverVersion,
    error
  }
}

/** 概览：docker info 全量 + docker system df（镜像/容器/卷/构建缓存的占用与可回收量） */
export async function dockerOverview(exec: ExecFn): Promise<DockerOverview> {
  const script = [
    'export LC_ALL=C',
    "echo @@INFO@@; docker info --format '{{json .}}' 2>&1",
    "echo @@DF@@; docker system df --format '{{json .}}' 2>&1"
  ].join('; ')

  const { stdout } = await exec(script)
  const segments = stdout.split('@@')
  const pick = (tag: string): string => {
    const idx = segments.indexOf(tag)
    return idx >= 0 ? (segments[idx + 1] ?? '').trim() : ''
  }

  const infoRaw = pick('INFO')
  let info: Record<string, unknown> = {}
  if (infoRaw.startsWith('{')) {
    try {
      info = JSON.parse(infoRaw) as Record<string, unknown>
    } catch {
      info = {}
    }
  }

  const str = (key: string): string => String(info[key] ?? '')
  const int = (key: string): number => {
    const n = Number(info[key])
    return Number.isFinite(n) ? n : 0
  }

  const df = jsonLines<Record<string, string>>(pick('DF')).map<DockerDfRow>((row) => ({
    type: row.Type ?? '',
    total: Number(row.TotalCount ?? 0) || 0,
    active: Number(row.Active ?? 0) || 0,
    size: row.Size ?? '',
    reclaimable: row.Reclaimable ?? ''
  }))

  return {
    info: {
      name: str('Name'),
      serverVersion: str('ServerVersion'),
      operatingSystem: str('OperatingSystem'),
      kernelVersion: str('KernelVersion'),
      architecture: str('Architecture'),
      driver: str('Driver'),
      rootDir: str('DockerRootDir'),
      cpus: int('NCPU'),
      memoryTotal: int('MemTotal'),
      containers: int('Containers'),
      running: int('ContainersRunning'),
      paused: int('ContainersPaused'),
      stopped: int('ContainersStopped'),
      images: int('Images'),
      // Swarm 在 info JSON 里是字符串（inactive / active / locked），不是对象
      swarm: str('Swarm') === 'active',
      warnings: Array.isArray(info['Warnings']) ? (info['Warnings'] as string[]).join('; ') : ''
    },
    df
  }
}

/** 容器列表（含已停止的）。字段名来自 `docker ps --format json` 的 Go 模板输出 */
export async function dockerContainers(exec: ExecFn): Promise<DockerContainer[]> {
  const { stdout, stderr, code } = await exec(
    `export LC_ALL=C; docker ps -a --format '{{json .}}' 2>&1`
  )
  if (code !== 0 && !stdout.includes('{')) throw new Error(stderr || stdout || '容器列表获取失败')
  return jsonLines<Record<string, string>>(stdout).map((row) => ({
    id: row.ID ?? '',
    name: row.Names ?? '',
    image: row.Image ?? '',
    command: row.Command ?? '',
    state: (row.State ?? '').toLowerCase(),
    status: row.Status ?? '',
    ports: row.Ports ?? '',
    created: row.CreatedAt ?? '',
    runningFor: row.RunningFor ?? '',
    networks: row.Networks ?? '',
    mounts: row.Mounts ?? '',
    labels: row.Labels ?? ''
  }))
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove'

export async function dockerContainerAction(
  exec: ExecFn,
  id: string,
  action: ContainerAction,
  force = false
): Promise<string> {
  const ref = sh(safeRef(id))
  const cmd =
    action === 'remove'
      ? `docker rm ${force ? '-f ' : ''}${ref}`
      : `docker ${action} ${ref}`
  const { stdout, stderr, code } = await exec(`${cmd} 2>&1`)
  if (code !== 0) throw new Error((stderr || stdout).trim() || `docker ${action} 失败`)
  return (stdout || stderr).trim()
}

/** 日志：--timestamps 让「什么时候炸的」能直接看出来；tail 由界面给（默认 300 行） */
export async function dockerContainerLogs(
  exec: ExecFn,
  id: string,
  tail = 300
): Promise<string> {
  const n = Math.min(Math.max(Math.trunc(tail) || 300, 1), 5000)
  const ref = sh(safeRef(id))
  const { stdout, stderr } = await exec(`docker logs --tail ${n} --timestamps ${ref} 2>&1`)
  return stdout || stderr || '（没有输出）'
}

/** 详情：inspect 原文（JSON）+ 一次 stats 快照（CPU/内存/网络/磁盘） */
export async function dockerContainerDetail(
  exec: ExecFn,
  id: string
): Promise<DockerContainerDetail> {
  const ref = sh(safeRef(id))
  const { stdout } = await exec(
    `export LC_ALL=C; echo @@INSPECT@@; docker inspect ${ref} 2>&1; echo @@STATS@@; docker stats --no-stream --format '{{json .}}' ${ref} 2>/dev/null || true`
  )
  const segments = stdout.split('@@')
  const pick = (tag: string): string => {
    const idx = segments.indexOf(tag)
    return idx >= 0 ? (segments[idx + 1] ?? '').trim() : ''
  }

  let inspect: unknown = null
  const inspectRaw = pick('INSPECT')
  if (inspectRaw.startsWith('[')) {
    try {
      const arr = JSON.parse(inspectRaw) as unknown[]
      inspect = arr[0] ?? null
    } catch {
      inspect = null
    }
  }

  const statsRows = jsonLines<Record<string, string>>(pick('STATS'))
  const row = statsRows[0]
  const stats: DockerStats | null = row
    ? {
        cpu: row['CPUPerc'] ?? '',
        mem: row['MemUsage'] ?? '',
        memPerc: row['MemPerc'] ?? '',
        netIO: row['NetIO'] ?? '',
        blockIO: row['BlockIO'] ?? '',
        pids: row['PIDs'] ?? ''
      }
    : null

  return { inspect, stats, raw: inspectRaw }
}

export async function dockerImages(exec: ExecFn): Promise<DockerImage[]> {
  const { stdout } = await exec(`export LC_ALL=C; docker images --format '{{json .}}' 2>&1`)
  return jsonLines<Record<string, string>>(stdout).map((row) => ({
    id: row.ID ?? '',
    repository: row.Repository ?? '',
    tag: row.Tag ?? '',
    created: row.CreatedSince ?? row.CreatedAt ?? '',
    size: row.Size ?? '',
    digest: row.Digest ?? ''
  }))
}

export async function dockerRemoveImage(exec: ExecFn, ref: string, force = false): Promise<string> {
  const { stdout, stderr, code } = await exec(
    `docker rmi ${force ? '-f ' : ''}${sh(safeRef(ref))} 2>&1`
  )
  if (code !== 0) throw new Error((stderr || stdout).trim() || '删除镜像失败')
  return stdout.trim()
}

export async function dockerPullImage(exec: ExecFn, ref: string): Promise<string> {
  // 拉取可能几十秒，exec 会一直挂着直到 pull 结束（ssh 默认没超时）
  const { stdout, stderr, code } = await exec(`docker pull ${sh(safeRef(ref))} 2>&1`)
  if (code !== 0) throw new Error((stderr || stdout).trim() || '拉取镜像失败')
  const lines = stdout.trim().split('\n')
  return lines.slice(-3).join('\n')
}

export async function dockerNetworks(exec: ExecFn): Promise<DockerNetwork[]> {
  const { stdout } = await exec(`export LC_ALL=C; docker network ls --format '{{json .}}' 2>&1`)
  return jsonLines<Record<string, string>>(stdout).map((row) => ({
    id: row.ID ?? '',
    name: row.Name ?? '',
    driver: row.Driver ?? '',
    scope: row.Scope ?? '',
    internal: String(row.Internal ?? '') === 'true'
  }))
}

export async function dockerVolumes(exec: ExecFn): Promise<DockerVolume[]> {
  const { stdout } = await exec(`export LC_ALL=C; docker volume ls --format '{{json .}}' 2>&1`)
  return jsonLines<Record<string, string>>(stdout).map((row) => ({
    name: row.Name ?? '',
    driver: row.Driver ?? '',
    scope: row.Scope ?? ''
  }))
}

export async function dockerRemoveNetwork(exec: ExecFn, id: string): Promise<string> {
  const { stdout, stderr, code } = await exec(`docker network rm ${sh(safeRef(id))} 2>&1`)
  if (code !== 0) throw new Error((stderr || stdout).trim() || '删除网络失败')
  return stdout.trim()
}

export async function dockerRemoveVolume(exec: ExecFn, name: string): Promise<string> {
  const { stdout, stderr, code } = await exec(`docker volume rm ${sh(safeRef(name))} 2>&1`)
  if (code !== 0) throw new Error((stderr || stdout).trim() || '删除卷失败')
  return stdout.trim()
}

/** compose 项目：docker compose ls 的 JSON 是数组，老版本没有 ls，失败就返回空 */
export async function dockerCompose(exec: ExecFn): Promise<DockerComposeProject[]> {
  const { stdout } = await exec(
    `export LC_ALL=C; docker compose ls --format json 2>/dev/null || docker-compose ls 2>/dev/null || echo '[]'`
  )
  const text = stdout.trim()
  if (!text.startsWith('[')) return []
  try {
    const arr = JSON.parse(text) as Record<string, string>[]
    return arr.map((row) => ({
      name: row.Name ?? '',
      status: row.Status ?? '',
      configFiles: row.ConfigFiles ?? ''
    }))
  } catch {
    return []
  }
}

export type PruneTarget = 'container' | 'image' | 'volume' | 'builder' | 'all'

/** 清理：容器/悬空镜像/未使用卷/构建缓存；all 走 docker system prune */
export async function dockerPrune(exec: ExecFn, target: PruneTarget): Promise<string> {
  const cmd =
    target === 'all'
      ? 'docker system prune -f'
      : target === 'container'
        ? 'docker container prune -f'
        : target === 'image'
          ? 'docker image prune -f'
          : target === 'volume'
            ? 'docker volume prune -f'
            : 'docker builder prune -f'
  const { stdout, stderr, code } = await exec(`${cmd} 2>&1`)
  if (code !== 0) throw new Error((stderr || stdout).trim() || '清理失败')
  const lines = (stdout || stderr).trim().split('\n').filter(Boolean)
  return lines.slice(-4).join('\n')
}
