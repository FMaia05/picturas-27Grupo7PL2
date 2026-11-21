# Ambiente de medição (baseline)

Gerado por `benchmarks/baseline/env_capture.sh` em 2026-11-21T17:42:24Z (UTC).

## Código

| Campo | Valor |
|---|---|
| `git rev-parse HEAD` | `052310226c51fa57a17101c7bd1ad795674aac95` |
| Commit | 0523102 2026-11-04 Tell students replacing Phase 1 to wipe old Docker volumes (#37) |
| Alterações ao código da aplicação | 0 ficheiros versionados modificados (só `benchmarks/` e `docs/` são novos, não versionados) |
| Projeto Compose | `picturas-baseline` (volumes novos, sem alterar `docker-compose.yaml`) |

## Máquina anfitriã

| Campo | Valor |
|---|---|
| Modelo | Vivobook_ASUSLaptop M1502YA_M1502YA |
| SO | Microsoft Windows 11 Home 10.0.26200 (build 26200) |
| CPU | AMD Ryzen 7 7730U with Radeon Graphics, 8 núcleos / 16 threads, 2000 MHz |
| RAM | 15,4 GiB |
| Alimentação | bateria 90% (estado 2; 2 = ligado à corrente) |

## Docker

| Campo | Valor |
|---|---|
| Docker | Docker version 28.3.3, build 980b856 |
| Docker Compose | Docker Compose version v2.39.2-desktop.1 |
| Motor | 28.3.3, Docker Desktop (containerized), kernel 6.18.58.1-microsoft-standard-WSL2 |
| Recursos da VM do Docker | 16 CPUs, 8010989568 bytes (7.46 GiB) |
| Limites por contentor | nenhum (`docker-compose.yaml` não define `cpus`/`mem_limit`/réplicas) |

## Contentores em execução no momento da captura

```
picturas-baseline-frontend-1	picturas-baseline-frontend	Up 2 minutes
picturas-baseline-nginx-1	nginx:latest	Up 2 minutes
picturas-baseline-api_gateway-1	picturas-baseline-api_gateway	Up 3 minutes
picturas-baseline-ws_gateway-1	picturas-baseline-ws_gateway	Up 3 minutes
picturas-baseline-img_storage-1	picturas-baseline-img_storage	Up 3 minutes
picturas-baseline-rotate_tool-1	picturas-baseline-rotate_tool	Up 3 minutes
picturas-baseline-cut_tool-1	picturas-baseline-cut_tool	Up 3 minutes
picturas-baseline-projects-1	picturas-baseline-projects	Up 3 minutes
picturas-baseline-users-1	picturas-baseline-users	Up 3 minutes
picturas-baseline-resize_tool-1	picturas-baseline-resize_tool	Up 3 minutes
picturas-baseline-video_tool-1	picturas-baseline-video_tool	Up 3 minutes
picturas-baseline-border_tool-1	picturas-baseline-border_tool	Up 3 minutes
picturas-baseline-brightness_tool-1	picturas-baseline-brightness_tool	Up 3 minutes
picturas-baseline-contrast_tool-1	picturas-baseline-contrast_tool	Up 3 minutes
picturas-baseline-binarization_tool-1	picturas-baseline-binarization_tool	Up 3 minutes
picturas-baseline-saturation_tool-1	picturas-baseline-saturation_tool	Up 3 minutes
picturas-baseline-users_mongoDB-1	mongo:4.4	Up 3 minutes (healthy)
picturas-baseline-seaweedfs-1	chrislusf/seaweedfs:4.47	Up 3 minutes
picturas-baseline-rabbitmq-1	picturas-baseline-rabbitmq	Up 3 minutes (healthy)
picturas-baseline-projects_mongoDB-1	mongo:4.4	Up 3 minutes (healthy)
mysql-10.9.0.6	seed-image-mysql	Up 2 hours
```

Outras cargas: as stacks antigas (Fase 1, projeto `picturas`) e Supabase foram paradas com
`docker stop` antes das medições; qualquer outro contentor listado acima fora de `picturas-baseline-*` estava
em execução durante as medições.

## Imagens da stack em medição

```
picturas-baseline-video_tool:latest	7463c3507631	2026-11-21 17:36:22 +0000 GMT	1.74GB
picturas-baseline-img_storage:latest	af31faa8efd9	2026-11-21 17:27:18 +0000 GMT	1.94GB
picturas-baseline-projects:latest	bc5544fa74ba	2026-11-21 17:25:32 +0000 GMT	2.49GB
picturas-baseline-users:latest	93755af5f6a3	2026-11-21 17:20:03 +0000 GMT	1.87GB
picturas-baseline-api_gateway:latest	e6955321fd75	2026-11-21 17:19:28 +0000 GMT	1.81GB
picturas-baseline-cut_tool:latest	d74f30478312	2026-11-21 15:32:18 +0000 GMT	229MB
picturas-baseline-brightness_tool:latest	9bcf3326e993	2026-11-21 15:32:01 +0000 GMT	229MB
picturas-baseline-binarization_tool:latest	9ffe7e3a8e3d	2026-11-21 15:31:59 +0000 GMT	229MB
picturas-baseline-rotate_tool:latest	b2f43a1c1e42	2026-11-21 15:31:59 +0000 GMT	229MB
picturas-baseline-border_tool:latest	4c1ce8fcb609	2026-11-21 15:31:53 +0000 GMT	229MB
picturas-baseline-contrast_tool:latest	fcedb003ed43	2026-11-21 15:31:52 +0000 GMT	229MB
picturas-baseline-saturation_tool:latest	ffc5674e2850	2026-11-21 15:31:26 +0000 GMT	229MB
picturas-baseline-resize_tool:latest	42fb90c5ad97	2026-11-21 15:31:26 +0000 GMT	229MB
picturas-baseline-frontend:latest	ee424e7a45cb	2026-11-21 15:30:42 +0000 GMT	3.25GB
picturas-baseline-expand_ai_tool:latest	88d2a29ded16	2026-11-21 15:30:03 +0000 GMT	1.65GB
picturas-baseline-ws_gateway:latest	c6f0964418e2	2026-11-21 15:28:09 +0000 GMT	1.61GB
picturas-baseline-rabbitmq:latest	ed59664ad06f	2026-11-21 15:27:42 +0000 GMT	410MB
```

## Ferramentas no anfitrião

| Ferramenta | Versão |
|---|---|
| Python (scripts) | Python 3.12.6 |
| Pacotes Python | python-socketio==5.11.4 requests==2.32.3 websocket-client==1.8.0  |
