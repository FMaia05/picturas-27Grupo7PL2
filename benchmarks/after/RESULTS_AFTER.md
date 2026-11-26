# Medição final da Fase 2 — antes e depois do _refactoring_

Valores medidos; nenhum foi estimado. Os dados brutos estão em `results_base/` (base, medida
de novo em 2026-11-26) e `results/` (versão refatorada). A baseline original de 2026-11-21
está em `../baseline/`.

| Campo | Valor |
|---|---|
| Base | `0523102` (projeto Compose `picturas-baseline`) |
| Depois | `fase2/baseline` (commits de DA-1/DA-2 e correções desta entrega), projeto Compose `picturas-after`, volumes novos |
| Máquina | a da baseline (`../baseline/environment.md`): Ryzen 7 7730U, VM Docker de 16 CPUs e 7,46 GiB |
| Condições de C1-A, C1-B, C2-B, C2-E | base e depois medidas **de seguida, na mesma sessão** (2026-11-26, 14:18–15:06 UTC), **com o carregador ligado**, sem outras cargas pesadas (`measure_both.sh`, `measure_both.log`, `*/power.log`) |
| Serviços | `../baseline/services.txt` (o «depois» acrescenta `video_preview_tool` e `video_subtitles_tool`) |
| Scripts | os da baseline, adaptados para observarem todos os contentores de vídeo; as definições das métricas não mudaram |

## Como repetir

```bash
bash benchmarks/after/measure_both.sh          # base e depois, de seguida (~50 min)
PY=benchmarks/baseline/.venv/Scripts/python.exe
PICTURAS_PROJECT=picturas-after PICTURAS_RESULTS=benchmarks/after/results \
  $PY benchmarks/baseline/c2_reliability.py c2a   # e c2c, c2d, c2f
PICTURAS_PROJECT=picturas-after PICTURAS_RESULTS=benchmarks/after/results \
  $PY benchmarks/baseline/functional.py run        # 14 cenários de ponta a ponta
$PY benchmarks/baseline/functional.py compare benchmarks/baseline/results benchmarks/after/results
```

## CAND-1 — Eficiência de desempenho

| Métrica | Base (hoje) | Depois | Alvo | Mínimo | Atingido? |
|---|---|---|---|---|---|
| Débito com N = 4, C1-A (vídeos/min, média de 3) | 4,55 (2,65 / 5,47 / 5,53)¹ | **7,07** (7,09 / 6,93 / 7,18) | ≥ 10,5 | ≥ 8,0 | **Não** |
| Espera máxima em fila com N = 4, C1-A (s) | 69,83 (31,79 sem a repetição 1)¹ | **17,90** | ≤ 12,0 | ≤ 20,0 | **Mínimo** |
| Espera média em fila com N = 4 (s) | 21,94 | 7,66 | — | — | — |
| Débito com N = 2 (vídeos/min) | 4,18 | 7,24 | — | — | — |
| Pré-visualização durante a legendagem, C1-B, p50 (s) | 189,38 (3 amostras) | **4,26** (9 amostras; p95 5,17) | ≤ 5,0 | ≤ 10,5 | **Alvo** |
| Pré-visualização em vazio, p50 (s) | 2,57 | 2,72 | — | — | — |
| Legendagem do vídeo de 177 s (s) | 192,6 / 190,2 / 197,5 | 179,6 / 167,6 / 169,4 | — | — | — |
| RAM: limites explícitos e _OOMKill_ | sem limites; picos 1 248 MB (efeitos) / 2 490 MB (legendagem) | limites 896 / 896 / 768 / 3 072 MiB (5,5 GiB); picos 556 / 566 / 1 858 MB; **0 _OOMKill_** nas medições | ≤ 1 GiB e ≤ 3 GiB, 0 | soma ≤ 5,5 GiB, 0 | **Alvo**² |

¹ A repetição 1 da base foi perturbada (débito 2,65 contra 5,47 e 5,53 nas outras), provavelmente
pela paragem, logo antes, de 20 contentores de outra _stack_; não foi descartada.
² Só depois da correção de memória desta entrega (ver «Regressão encontrada»). Com os limites
iniciais, 1080p e 4K eram mortos por falta de memória.

**Porque é que o débito não chega ao alvo.** Com as duas réplicas ocupadas, o tempo de serviço
de cada vídeo sobe de 12,5 s (N = 1) para 16,9 s (N = 4): cada réplica está limitada a 3 CPUs
(`cpus: '3.0'`) e o pico observado foi de 304 %. O débito passa a ~1,5× o de N = 1, em vez de
2×. Com 2 réplicas, o alvo de 10,5 vídeos/min exigiria ~11,4 s por vídeo com ambas ocupadas.

## CAND-2 — Fiabilidade

| Métrica | Base | Depois | Alvo | Mínimo | Atingido? |
|---|---|---|---|---|---|
| C2-A: trabalhos perdidos no reinício do _broker_ | 4/4 (100 %) | **0/4 (0 %)** | 0 % | 0 % | **Alvo** |
| C2-A: religação do `projects` | não (reinício manual) | **sim, sem intervenção**³ | ≤ 15 s | ≤ 30 s | Sim; tempo não medido pelo script |
| C2-B: `docker kill` à réplica com o trabalho, até concluir (s) | 50,0 / 50,5 / 51,6⁴ | **10,1 / 10,2 / 10,4**, noutra réplica | ≤ 25 | ≤ 35 | **Alvo** |
| C2-E: queda real do processo (SIGKILL), até concluir (s) | 13,2 / 13,7 / 15,5 (reinício automático) | 11,6 / 11,7 / 12,7 | — | — | sem diferença relevante |
| Ficheiros parciais após C2-B / C2-E | 0 | 0 | 0 | 0 | **Alvo** |
| C2-C: libertação da mensagem de um _worker_ pausado (s) | > 115 (não libertada) | **48,3**; concluído noutra réplica aos 79,5 s | ≤ 60 | ≤ 90 | **Alvo** |
| C2-D1: resultados perdidos com o `img_storage` ~40 s em baixo | 1/1 (39,7 s) | **0/1** (43,3 s; concluído 51,4 s após a paragem, sem erro ao utilizador) | 0 | 0 | **Alvo** |
| C2-D2c: mensagem malformada injetada | sem limite, 10 reinícios em 90 s | **1 tentativa → `video_dlq`**, 0 reinícios | R ≤ 3 + DLQ | R ≤ 5 + DLQ | **Alvo** |
| C2-F: trabalho que mata o _worker_ em todas as tentativas | 7 tentativas em 6 quedas, sem limite | **3 tentativas → `video_dlq`**, erro 2001 ao utilizador | R ≤ 3 + DLQ | R ≤ 5 + DLQ | **Alvo** |

³ C2-A, C2-C e C2-F do «depois» medidos em 2026-11-25; C2-D em 2026-11-26 na bateria (contam o
resultado, não o tempo). Na base, C2-A/C/D são os de 2026-11-21 e C2-F o de 2026-11-25.
⁴ Inclui ~39 s em que o script espera antes de arrancar o contentor: o Docker trata `docker kill`
como paragem manual. Excluída essa espera, a base demorou 10,6–12,3 s.

## Preservação funcional

| Verificação | Resultado |
|---|---|
| `Tools/video/tests` (pytest, em Docker) | **93/93** (74 da base + 10 de DA-1/DA-2 + 9 das correções) — `results/pytest_video.log` |
| `projects/tests` (node --test, em Docker) | **20/20** (8 da base + 9 + 3) — `results/node_projects.log` |
| 14 cenários de ponta a ponta pela entrada pública (`functional.py`): cadeias de imagem, efeitos, corte/velocidade, MOV→MP4, projeto misto, extração de fotogramas, legendagem, 3 tipos de pré-visualização, trim inválido, cancelar e voltar a aplicar, _uploads_ recusados, quota diária | **14/14 iguais à base**, incluindo o _hash_ dos fotogramas descodificados de cada resultado |
| Vídeo 4K (3840x2160, premium) e 1080p dentro dos limites de memória (`c4k.py`) | edição, pré-visualização e legendagem concluídas, 0 _OOMKill_ |

## Regressão encontrada e corrigida

Com os limites de memória de DA-1, **1080p e 4K eram mortos por falta de memória**
(`results/c4k_before_thread_cap*.json`): o ffmpeg dimensiona as suas _threads_ pelos 16 CPUs
do anfitrião, não pelo limite do contentor. A base processa 4K com picos de 3,6–4 GB. Correção:
_threads_ do ffmpeg limitadas a 2 acima de 720p (abaixo disso o resultado é igual ao bit) e
vídeos acima de 1080p encaminhados para o _worker_ com 3 GB.

## Ameaças à validade

- 3 repetições por nível (C1-A), 9 pré-visualizações sobrepostas no «depois» e 3 na base (C1-B);
  1 execução por modo de falha em C2-A/C/D/F.
- A repetição 1 da base em C1-A foi perturbada e entra nas médias.
- C2-A, C2-C e C2-F do «depois» e C2-A/C/D da base não foram medidos na mesma sessão.
- Durante as medições corria um contentor `mysql` de outro projeto (`labsetup`).
- O tempo de religação do `projects` em C2-A não é medido pelos scripts.
