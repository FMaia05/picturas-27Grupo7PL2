# Baseline da Fase 2 — CAND-1 (desempenho) e CAND-2 (fiabilidade)

Medição inicial sobre a solução de base, **antes de qualquer refactoring**. Todos os valores
abaixo foram obtidos por execução local em 2026-11-21 (UTC); nenhum foi estimado. Os dados
brutos estão em `results/` e o ambiente em [`environment.md`](environment.md).

| Campo | Valor |
|---|---|
| Commit medido | `052310226c51fa57a17101c7bd1ad795674aac95` (sem alterações ao código nem ao `docker-compose.yaml`) |
| Máquina | ASUS Vivobook M1502YA, AMD Ryzen 7 7730U (8 núcleos / 16 threads), 15,4 GiB RAM, Windows 11 Home 26200, ligado à corrente |
| Docker | Docker 28.3.3, Compose v2.39.2, Docker Desktop/WSL2 com **16 CPUs e 7,46 GiB** na VM |
| Projeto Compose | `picturas-baseline` (volumes novos; stacks antigas paradas com `docker stop`) |
| Serviços em execução | subconjunto de [`services.txt`](services.txt) (ver «Desvios») |
| Testes de regressão | `Tools/video/tests` **74/74**, `projects/tests` **8/8** ([`regression_baseline.log`](regression_baseline.log)) |

## Como repetir

```bash
# na raiz do repositório, no commit de base
python -m venv benchmarks/baseline/.venv
benchmarks/baseline/.venv/Scripts/python.exe -m pip install -r benchmarks/baseline/requirements.txt
bash benchmarks/baseline/build_stack.sh            # constrói e arranca services.txt (projeto picturas-baseline)
bash benchmarks/baseline/env_capture.sh            # -> environment.md
bash benchmarks/baseline/run_regression.sh         # -> regression_baseline.log
PY=benchmarks/baseline/.venv/Scripts/python.exe
$PY benchmarks/baseline/c1_performance.py warmup   # descartado: carrega o modelo Whisper e aquece o ffmpeg
$PY benchmarks/baseline/c1_performance.py c1a --reps 3 --levels 1,2,4
$PY benchmarks/baseline/c1_performance.py c1b --reps 3
$PY benchmarks/baseline/c2_reliability.py c2a      # e c2b, c2c, c2d (ou: all)
```

`run_all.sh` encadeia tudo. Os scripts falam apenas com a entrada pública
(`https://localhost:8080`, API Gateway e Socket.IO) e observam o sistema com o CLI do `docker`
(`logs`, `stats`, `kill`, `pause`), a API de gestão do RabbitMQ (`:15672`) e consultas só de leitura
ao MongoDB do `projects`. As contas de teste são criadas como `premium` através da API (`POST
/users`), o que dispensa repor contadores de operações diárias.

## Definições das métricas

| Métrica | Definição | Relógio |
|---|---|---|
| Espera em fila (s) | início do trabalho no `video_tool` (linha `[video] msg=…` do log) − `Process.createdAt` (publicação na `video_queue`) | VM do Docker |
| Tempo de serviço (s) | linha `[video] msg=… ok` − início do trabalho | VM do Docker |
| Tempo fim-a-fim (s) | chegada do evento Socket.IO (`process-update` / `preview-ready`) − envio do pedido HTTP | anfitrião |
| Débito (vídeos/min) | N concluídos / (última conclusão − primeiro envio) × 60 | anfitrião |
| Pico de CPU / RAM | máximo de `docker stats --no-stream` amostrado a cada ~2 s (o script pede 1 s, mas cada chamada demora ~2 s: período medido 2,0–2,1 s; picos mais curtos podem escapar) (CPU em % de 1 núcleo; 1600 % = 16 CPUs) | anfitrião |
| Percentis | método do posto mais próximo, sem interpolação (com 3 amostras, p95 = máximo) | — |

---

## CAND-1 — Eficiência de desempenho (capacidade / comportamento temporal)

### C1-A — Concorrência homogénea (valida H-01)

N utilizadores premium, cada um com um projeto, submetem *Apply* em simultâneo (barreira de
threads) sobre `sample_10s_720p.mp4` com `brightness + contrast + saturation` (fatores aleatórios em
[1,05; 1,35]). 3 repetições por N. Dados: `results/c1a_summary.json`, `c1a_jobs.csv`,
`c1a_docker_stats.csv`.

| N | Trabalhos concluídos | Débito médio (vídeos/min) [mín–máx] | *Makespan* médio (s) | Espera em fila média / máx. (s) | Tempo de serviço médio (s) | Fim-a-fim p50 / máx. (s) | Pico CPU `video_tool` | Pico RAM `video_tool` |
|---|---|---|---|---|---|---|---|---|
| 1 | 3/3 | **5,48** [5,24–5,62] | 10,96 | 0,05 / 0,06 | 11,11 | 10,76 / 11,45 | 254 % | 603 MB |
| 2 | 6/6 | **5,38** [4,83–5,67] | 22,45 | 5,91 / 15,02 | 11,09 | 14,03 / 24,85 | 278 % | 614 MB |
| 4 | 12/12 | **5,37** [4,81–5,65] | 44,93 | 17,84 / 38,96 | 10,90 | 29,24 / 49,85 | 331 % | 632 MB |

**Leitura.** O débito **não cresce com N** (≈ 5,4 vídeos/min em todos os níveis) e o *makespan*
cresce linearmente (≈ 11 s × N). A espera em fila do k-ésimo trabalho é ≈ (k − 1) × 10 s, como se
vê em `c1a_jobs.csv` (0,06 / 10,3 / 21 / 30–39 s com N = 4). O tempo de serviço é estável
(10,9–11,1 s), por isso todo o atraso adicional é espera na `video_queue`: **H-01 confirmada**, o
processamento de vídeo está serializado num único consumidor. Durante a carga o `video_tool` usou no
máximo 2,5–3,3 dos 16 CPUs da VM, o que deixa folga de CPU para paralelismo (relevante para H-09).

### C1-B — Isolamento sob carga de legendagem (valida H-02)

Por repetição:
1. Um preview de aquecimento, descartado.
2. Três previews de 3 s em vazio (utilizador B, `sample_10s_720p.mp4`, `brightness` com fator
   aleatório, para nunca acertar na cache de previews).
3. O utilizador A faz *Apply* com legendagem automática em `speech_mandela_177s_1080p.webm`.
4. 5 s depois, B pede três previews sequenciais noutros projetos.

3 repetições. Dados: `results/c1b_summary.json`, `c1b_previews.csv`, `c1b_docker_stats_r*.csv`.

| Medição | Amostras | p50 (s) | p95 (s) | Valores |
|---|---|---|---|---|
| Latência de preview em vazio | 9 | **2,08** | 2,32 | 1,97–2,32 |
| Latência do preview pedido durante a legendagem | 3 | **171,28** | 173,26 | 173,26 / 171,28 / 163,60 |
| … dos quais espera em fila | 3 | 169,48 | 171,45 | 171,45 / 169,48 / 161,23 |
| … dos quais tempo de serviço | 3 | 2,03 | 3,67 | 2,03 / 1,84 / 3,67 |
| Legendagem do vídeo de 177 s (fim-a-fim) | 3 | 174,52 | 176,38 | 176,38 / 174,52 / 166,64 |
| Pico do `video_tool` durante a legendagem | 3 | — | — | CPU 1036–1136 %, RAM 2474–2533 MB |

**Leitura.** Um preview de ~2 s pedido 5 s depois de uma legendagem demora **≈ 82×** mais
(p50 171,3 s / 2,08 s). Praticamente todo esse tempo é espera em fila: o tempo de serviço do
preview mantém-se em ~2 s. O preview só arranca quando a legendagem termina. Os previews 2 e 3 de
cada repetição já foram pedidos depois do fim da legendagem (sequenciais) e por isso medem ~2 s;
estão marcados `overlapped_subtitles = false` em `c1b_previews.csv` e **não** entram na linha
«durante a legendagem». **H-02 confirmada.** Durante a legendagem o `video_tool` chegou a
~2,5 GB de RAM (um terço da VM) e ~10–11 CPUs: replicar este trabalho sem limites tem um custo real
de memória (H-09).

---

## CAND-2 — Fiabilidade (tolerância a falhas / recuperabilidade)

Injeção de falhas com `docker stop/kill/pause` e com a API de gestão do RabbitMQ; o trabalho usado é
o de C1-A com N = 1 (serviço ≈ 11 s). Dados: `results/c2*_*.json` e `results/c2*_run.log`.

| Cenário | Medição | Resultado na base |
|---|---|---|
| **C2-A** reinício do broker com 4 trabalhos na `video_queue` (H-06) | Trabalhos perdidos | **4/4 (100 %)**. Fila: 4 mensagens prontas antes do reinício, **0 depois** (mensagens não persistentes) |
| | Execuções presas | **4/4**: `Process` pendente, `activeToken = 1`, `committedToken = 0`, nenhum evento enviado ao utilizador em 180 s |
| | Recuperação dos serviços | Depois do reinício, o `projects` continuou em execução mas ficou com **0 consumidores na `project_queue`**: não volta a ligar-se ao broker. Foi preciso `docker compose restart projects` (observado em duas execuções). O `ws_gateway` voltou a ligar-se sozinho. |
| **C2-B** `docker kill` ao `video_tool` a 51 % (H-05), 3 repetições | Reentrega | **3/3 reentregues** (2 inícios do mesmo `msg_id` no log); concluídos com `process-update` |
| | Reinício automático do worker | **Não avaliável neste cenário (0/3).** O Docker trata `docker kill` como paragem manual e ignora `restart: on-failure`. É um artefacto da injeção, não uma fragilidade: numa queda do processo o contentor reinicia sozinho (C2-D(2c): 2 reinícios em 5,4 s) |
| | Tempo kill → conclusão | 53,16 / 58,89 / 50,53 s (média 54,2 s). Destes, **39,5–41,0 s são espera do script** até arrancar o contentor à mão; do arranque até concluir: **12,1 / 19,4 / 11,1 s (média 14,2 s)** |
| | Integridade | 0 ficheiros parciais (`.part`); `out/sample_10s_720p.mp4` válido no `ffprobe`; 1 resultado; execução *committed* |
| **C2-C** `docker pause` ao `video_tool` a 51 % durante 120 s (H-10) | Mensagem recuperada pelo broker | **Não, na janela observada (última amostra aos 115,5 s)**: `messages_unacknowledged = 1` e `messages_ready = 0` dos 5 s aos 115 s (a amostra dos 0,2 s ainda mostrava estatísticas anteriores); consumidor sempre «ativo» (`heartbeat = 0`). O RabbitMQ 4.0.5 tem `consumer_timeout` = 1 800 000 ms (30 min, lido do broker), por isso a retenção não é ilimitada; o comportamento depois dos 115,5 s não foi medido |
| | Informação ao utilizador | Só eventos `video-progress` anteriores à pausa; nenhum erro nem *timeout* em 120 s |
| | Depois do `unpause` | Concluído em 4,87 s (1 início, sem reentrega) |
| **C2-D(1)** `img_storage` parado enquanto o `projects` trata a resposta (H-07) | Resultado | O worker concluiu (`ok`), mas o `projects` falhou ao guardar a saída: **evento `process-error` 30000** genérico; resultado **perdido** (0 `Result`) |
| | Nova tentativa automática | **Nenhuma**: 0 mensagens na `project_queue` (já confirmada), `Process` apagado, execução nunca *committed* (`activeToken = 1`, `committedToken = 0`), mesmo 60 s depois de o `img_storage` voltar (estava em baixo há 39,7 s) |
| | Recuperação | Só manual: novo *Apply* → `process-update` |
| **C2-D(2a)** trim inválido (50–60 s num vídeo de 10 s) pela API | Tratamento | Aceite pela API (201) e rejeitado pelo worker: `process-error` 2003 em 0,28 s, **1 tentativa** |
| **C2-D(2b)** mensagem com ficheiro de entrada inexistente | Tratamento | Erro tratado pelo worker, **1 tentativa**, fila vazia ao fim de 20 s |
| **C2-D(2c)** mensagem malformada (`tools` não é lista) injetada na `video_queue` | Tentativas / reinícios | **10 reinícios do `video_tool` e 10 *tracebacks* em 90 s**; a mensagem continuava na fila no fim (sem limite de tentativas configurado; só foram observados 90 s). A mensagem foi injetada diretamente no broker: não se mostrou que a API pública a consiga produzir, com o serviço de vídeo indisponível. Foi preciso purgar a fila e reiniciar o worker |
| Configuração de *dead-letter* | Filas com DLX / DLQ | **Nenhuma** (`video_queue`: `{"x-queue-type": "classic"}`; sem políticas) |

**Leitura.**
- **H-06 confirmada:** a perda de mensagens no reinício do broker é total. Agrava-a o facto de o
  orquestrador perder o consumidor da `project_queue` sem terminar, o que afeta **todos** os
  trabalhos seguintes, de imagem e de vídeo, até um reinício manual.
- **H-05 confirmada nas duas vertentes:** a confirmação manual no fim faz a morte do worker ser
  recuperada por reentrega, sem ficheiros parciais; mas uma mensagem venenosa gera reentregas sem
  limite.
- **H-10 confirmada:** um worker bloqueado retém a mensagem durante toda a janela observada (> 115 s); só o `consumer_timeout` de 30 min a limitaria.
- **H-07:** confirmada na forma «falha de dependência durante o tratamento da resposta → trabalho
  perdido sem nova tentativa». A causa no código é o `channel.ack` imediato em `read_rabbit_msg`
  combinado com `Process.delete` antes do upload. O utilizador recebe um erro genérico.

---

## Valores para a secção 5.1 do Bloco 2

Valores **medidos** (base). Os valores-alvo e mínimos aceitáveis são decisão da equipa. A coluna
«Proposta para discussão» indica apenas uma origem possível, derivada destas medições, e não é um
resultado.

| Requisito | Escala | Valor medido na base | Proposta para discussão (alvo / mínimo) |
|---|---|---|---|
| CAND-1 | Débito com N = 4 (vídeos/min, C1-A) | 5,37 (5,48 com N = 1) | Escalar com o paralelismo disponível, p.ex. alvo ≥ 2× a base com N = 4, mínimo ≥ 1,5× |
| CAND-1 | Espera em fila máx. com N = 4 (s, C1-A) | 38,96 (média 17,84) | p.ex. alvo ≤ tempo de serviço de 1 trabalho (~11 s) |
| CAND-1 | Latência p50 de preview durante legendagem (s, C1-B) | 171,28 (vs 2,08 em vazio, ×82) | p.ex. alvo ≤ 2× a latência em vazio, mínimo ≤ 5× (K de QS-02) |
| CAND-1 | Pico de RAM do `video_tool` (MB) | 632 (efeitos) / 2533 (legendagem) | Limite explícito por contentor que caiba nos 7,46 GiB da VM com réplicas |
| CAND-2 | Perda em reinício do broker (%) | 100 % (4/4) e 4 execuções presas | alvo 0 % / mínimo 0 % (`REQ-VID-FAIL-004`) |
| CAND-2 | Recuperação automática do orquestrador após reinício do broker | não (0 consumidores, reinício manual) | alvo: sim, sem intervenção |
| CAND-2 | Trabalhos recuperados após morte do worker (%) | 100 % reentregues e concluídos (3/3), 0 ficheiros parciais; 14,2 s em média desde o arranque do contentor (54,2 s totais incluem ~40 s de espera do script) | não usar 54,2 s como termo de comparação; repetir com uma queda real do processo |
| CAND-2 | Tempo até libertar a mensagem de um worker bloqueado (s) | > 115 s (não medido além disso; `consumer_timeout` = 30 min) | p.ex. ≤ 2 × intervalo de *heartbeat* |
| CAND-2 | Tentativas de uma mensagem venenosa antes de DLQ | ilimitadas (10 reinícios em 90 s), sem DLQ | alvo R ≤ 3 e encaminhamento para DLQ |
| CAND-2 | Resultados perdidos por falha transitória do `img_storage` | 1/1 perdido, 0 novas tentativas | alvo 0 perdidos |

---

## Desvios, limitações e ameaças à validade

- **Subconjunto de serviços.** As ferramentas de IA de imagem, `generative-mock`, `watermark`,
  `subscriptions` e `mongo-backup` não foram arrancadas (ver `services.txt`). Nenhuma participa no
  caminho medido. A imagem `cut_ai_tool` exigia vários GB de *wheels* CUDA que a rede local não
  conseguiu descarregar (`results/build/`). A medição final tem de usar o mesmo `services.txt`.
- **Modelo Whisper.** O download pelo `video_tool` ficou parado a 0 bytes (Hugging Face muito lento).
  O `model.bin` de `Systran/faster-whisper-small` (revisão `536b066…`) foi descarregado do próprio
  huggingface.co no anfitrião, verificado por SHA-256 contra o identificador LFS
  (`3e305921…d671`) e colocado na cache do volume `whisper_models`, como o faria a biblioteca.
  O aquecimento (`results/c1_warmup.json`) confirmou que o modelo carrega da cache. O primeiro
  aquecimento, interrompido pelo download parado, foi retirado da fila e descartado.
- **Atrasos nas observações.** As estatísticas da API de gestão do RabbitMQ atualizam a cada
  ~5 s; os scripts esperam que estabilizem antes de ler. O relógio da VM
  desvia-se do anfitrião de forma variável: a publicação (VM) surge entre 0,43 s antes e 1,43 s
  depois do envio (anfitrião) e, em 3 dos 21 trabalhos do C1-A, o tempo de serviço (VM) excede o
  fim-a-fim (anfitrião) em 0,74–1,04 s. Espera em fila e tempo de serviço têm por isso um erro da
  ordem de 1–1,5 s; débito e fim-a-fim usam só o relógio do anfitrião e não são afetados.
- **Correção durante a medição.** A primeira execução do C1-B emparelhou os eventos
  `preview-ready` com desfasamento de um, porque os eventos não trazem ID e o relógio do Windows
  tem resolução de ~15 ms. Foi descartada (`results/invalid/`) e repetida com emparelhamento por
  ordem de chegada.
- **Amostras pequenas.** C1-A tem 3 repetições por nível e C1-B tem 3 previews sobrepostos (p95 =
  máximo). O C2 corre 1 vez por modo de falha, exceto o C2-B (3 vezes).
- **Ambiente.** Portátil sem fixação de frequência da CPU; durante o C1-A e o C2-A corria em
  paralelo, no anfitrião, um download HTTP (~120 KB/s) do modelo. Antes das medições foram paradas
  outras stacks Docker; continuava em execução um contentor `mysql` sem relação com o projeto.
- **Carga do RabbitMQ.** O `rabbitmq` registou picos de CPU de ~200–350 % com N = 4 e durante a
  legendagem. A causa não foi investigada: pode incluir as consultas da própria monitorização (API de
  gestão). A comparação antes/depois tem de usar os mesmos scripts.

## Correções a este documento

**2026-11-25** (dados brutos inalterados): C2-B separa a espera do script (~40 s, não 30 s) do tempo
de recuperação e deixa de apresentar a ausência de reinício como fragilidade; C2-C deixa de afirmar
retenção «indefinida»/∞; p50 do C1-A com N = 2 e 4 recalculados pelo posto mais próximo (estavam
interpolados: 17,60 e 30,71 s); período real de amostragem de `docker stats`; causa do desvio entre
relógios.
