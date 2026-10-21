# Testes da extensão de vídeo — registo de execução

O catálogo completo (cada teste no formato *Dado … Quando … Então*, com requisito e resultado),
os defeitos encontrados e as limitações estão no capítulo do relatório:
[`docs/relatorio/cap10-testes-validacao.md`](relatorio/cap10-testes-validacao.md).
Este ficheiro regista **como correr** os testes e o **resultado da última execução**. Ao
acrescentar ou alterar testes, atualizem os dois.

## Como correr

| Nível | Comando | Requisitos |
|-------|---------|------------|
| Gateway | `cd apiGateway && npm install && npm test` | Node 20+ |
| Componente (sem ffmpeg) | `cd imageStorageService && npm install && npm test` | Node 20+; as suites com ffmpeg são ignoradas |
| Componente (completo) | `docker compose build img_storage && docker compose run --rm --no-deps img_storage npm test` | Docker |
| Sistema (E2E) | `docker compose up -d` e depois `docker compose run --rm --no-deps img_storage npm run test:e2e` | Stack completa a correr |
| Frontend | `docker compose build frontend` (executa `next build`, com verificação de tipos) | Docker |
| Interface | Cenários TST-MAN-01 a TST-MAN-10 do Cap. 10, em `https://localhost:8080` | Stack completa; depois de alterar o frontend, `docker compose up -d -V frontend` |

O limite de 10 minutos das tarefas pode ser reduzido com `VIDEO_TASK_TIMEOUT_MS` (usado nos
testes TST-TRIM-14 e TST-FRAME-15).

## Última execução — 21 de outubro de 2026, *commit* `8fb6ade`

| Nível | Resultado |
|-------|-----------|
| `imageStorageService` (contentor, ffmpeg 5.1) | 58/58 ✔ |
| `apiGateway` | 16/16 ✔ |
| E2E (30 serviços) | 13/13 ✔ |
| Interface (Chromium *headless*, 1366×900) | 10/10 ✔ |
| Compilação de produção do frontend | ✔ |

Defeitos encontrados e corrigidos durante a verificação: D-01 a D-06. Tarefas de manutenção da
solução de base: T-12 a T-14. Questão em aberto: Q-01 (repetição após o tempo limite no recorte).
Detalhes no Cap. 10, secções 10.4 e 10.5.
