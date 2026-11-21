#!/usr/bin/env bash
# Records the measurement environment into environment.md (host, Docker VM, versions,
# commit and the containers of the stack under test). Run from any directory.
# Usage: bash benchmarks/baseline/env_capture.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
P="${PICTURAS_PROJECT:-picturas-baseline}"
OUT="$HERE/environment.md"

ps() { powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $1" 2>/dev/null | tr -d '\r'; }

{
  echo "# Ambiente de medição (baseline)"
  echo
  echo "Gerado por \`benchmarks/baseline/env_capture.sh\` em $(date -u +%FT%TZ) (UTC)."
  echo
  echo "## Código"
  echo
  echo "| Campo | Valor |"
  echo "|---|---|"
  echo "| \`git rev-parse HEAD\` | \`$(git -C "$REPO" rev-parse HEAD)\` |"
  echo "| Commit | $(git -C "$REPO" log -1 --format='%h %cs %s') |"
  echo "| Alterações ao código da aplicação | $(git -C "$REPO" status --porcelain --untracked-files=no | wc -l | tr -d ' ') ficheiros versionados modificados (só \`benchmarks/\` e \`docs/\` são novos, não versionados) |"
  echo "| Projeto Compose | \`$P\` (volumes novos, sem alterar \`docker-compose.yaml\`) |"
  echo
  echo "## Máquina anfitriã"
  echo
  echo "| Campo | Valor |"
  echo "|---|---|"
  if command -v powershell.exe >/dev/null; then
    echo "| Modelo | $(ps '(Get-CimInstance Win32_ComputerSystem).Model') |"
    echo "| SO | $(ps '$o=Get-CimInstance Win32_OperatingSystem; "$($o.Caption) $($o.Version) (build $($o.BuildNumber))"') |"
    echo "| CPU | $(ps '$c=Get-CimInstance Win32_Processor; "$($c.Name.Trim()), $($c.NumberOfCores) núcleos / $($c.NumberOfLogicalProcessors) threads, $($c.MaxClockSpeed) MHz"') |"
    echo "| RAM | $(ps '"{0:N1} GiB" -f ((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB)') |"
    echo "| Alimentação | $(ps '$b=Get-CimInstance Win32_Battery; if ($b) { "bateria $($b.EstimatedChargeRemaining)% (estado $($b.BatteryStatus); 2 = ligado à corrente)" } else { "sem bateria" }') |"
  else
    echo "| SO | $(uname -a) |"
    echo "| CPU | $(nproc) CPUs |"
  fi
  echo
  echo "## Docker"
  echo
  echo "| Campo | Valor |"
  echo "|---|---|"
  echo "| Docker | $(docker --version) |"
  echo "| Docker Compose | $(docker compose version) |"
  echo "| Motor | $(docker info --format '{{.ServerVersion}}, {{.OperatingSystem}}, kernel {{.KernelVersion}}') |"
  echo "| Recursos da VM do Docker | $(docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes') ($(docker info --format '{{.MemTotal}}' | awk '{printf "%.2f GiB", $1/1073741824}')) |"
  echo "| Limites por contentor | nenhum (\`docker-compose.yaml\` não define \`cpus\`/\`mem_limit\`/réplicas) |"
  echo
  echo "## Contentores em execução no momento da captura"
  echo
  echo '```'
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  echo '```'
  echo
  echo "Outras cargas: as stacks antigas (Fase 1, projeto \`picturas\`) e Supabase foram paradas com"
  echo "\`docker stop\` antes das medições; qualquer outro contentor listado acima fora de \`$P-*\` estava"
  echo "em execução durante as medições."
  echo
  echo "## Imagens da stack em medição"
  echo
  echo '```'
  docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}' | grep "^$P-" || true
  echo '```'
  echo
  echo "## Ferramentas no anfitrião"
  echo
  echo "| Ferramenta | Versão |"
  echo "|---|---|"
  echo "| Python (scripts) | $("$HERE/.venv/Scripts/python.exe" --version 2>/dev/null || python --version 2>&1) |"
  echo "| Pacotes Python | $("$HERE/.venv/Scripts/python.exe" -m pip freeze 2>/dev/null | grep -iE '^(requests|python-socketio|websocket-client)=' | tr '\n' ' ') |"
} > "$OUT"
echo "wrote $OUT"
