# Testes e validação do MVP de vídeo — Fase 1

Fonte para os capítulos 7.3 (realização e verificação) e 10 (testes e validação) do relatório.
Os IDs de requisito citados são os que constam no código. Os requisitos de upload/biblioteca
estão referidos pelo caso de uso e devem ser alinhados com os IDs `REQ-VID-SUBMIT-*` /
`REQ-VID-LIB-*` do relatório. **Confirmar a numeração final dos UC antes de copiar para o relatório.**

## 1. Estratégia e ambiente

| Nível | Ferramenta | O que substitui | Como correr |
|-------|------------|-----------------|-------------|
| Componente (rotas) | `node:test` + `fetch` sobre o router Express real | MongoDB, S3 e workers por *fakes* em memória | `cd imageStorageService && npm test` |
| Componente (workers) | `node:test` + **ffmpeg/ffprobe reais** sobre vídeos gerados | MongoDB, S3, `users` e `projects` por *fakes* | `docker compose run --rm --no-deps img_storage npm test` |
| Gateway | `node:test`, JWT reais, `axios` simulado | `users` e `img_storage` | `cd apiGateway && npm test` |
| Sistema (E2E) | `node:test` contra a stack completa via nginx | nada | `docker compose up -d` e `docker compose run --rm --no-deps img_storage npm run test:e2e` |
| Manual | Browser em `https://localhost:8080` | nada | Lista da secção 4 |

Ambiente de execução: Windows 11 + Docker Desktop 4.45 (engine 28.3.3), Node 22.19 no host,
Node 20 + ffmpeg (Debian bookworm) na imagem `img_storage`.

## 2. Testes automáticos — componente e gateway

Resultado da execução de 2026-10-18 na branch `feat/fase1-testes-evidencias`:
**imageStorageService 53/53 ✔** (no contentor, com ffmpeg) e **apiGateway 16/16 ✔**.

### Upload e biblioteca (UC-VID-001 / UC-VID-002)

| ID | Tipo | Dado … Quando … Então | Requisito / regra | Resultado |
|----|------|------------------------|-------------------|-----------|
| TST-SEC-01 | Componente | Dado um pedido sem token interno ou com um token errado, quando chega ao `img_storage`, então é recusado com 403 | Convenção: rotas internas protegidas | ✔ |
| TST-UPLOAD-01 | Componente | Dado MP4/MOV/WebM com o MIME correspondente, quando o upload é iniciado, então é criada uma sessão `uploading` com partes de 8 MiB | Formatos suportados | ✔ |
| TST-UPLOAD-02 | Componente | Dado um nome malicioso (`../../etc/passwd.mp4`), quando o upload é iniciado, então a chave S3 é `videos/<uuid>.mp4` e o nome fica apenas como metadado | Chaves geradas pelo servidor | ✔ |
| TST-UPLOAD-03 | Componente | Dada uma extensão não suportada ou um MIME que não corresponde à extensão, quando o upload é iniciado, então é recusado com 400 e nada é criado | Formatos suportados | ✔ |
| TST-UPLOAD-04 | Componente | Dado um ficheiro de 200 MiB / 200 MiB+1 (gratuito) e de 2000 MiB / 2000 MiB+1 (Premium), quando o upload é iniciado, então o limite é aceite e o limite+1 é recusado | Limite por ficheiro por perfil | ✔ |
| TST-UPLOAD-05 | Componente | Dado um utilizador perto da quota total (1 GiB), quando inicia um upload que a excede, então recebe 413; vídeos `failed` e de outros utilizadores não contam | Quota total por perfil | ✔ |
| TST-UPLOAD-06 | Componente | Dada uma sessão ativa, quando chega uma parte com `uploadId` errado ou de outro utilizador, então é recusada com 404 | Propriedade da sessão | ✔ |
| TST-UPLOAD-07 | Componente | Dado um pedido de conclusão sem partes, então é recusado com 400 | Integridade | ✔ |
| TST-UPLOAD-08 | Componente | Dado um objeto final com tamanho diferente do declarado, quando o upload é concluído, então o objeto é apagado e o vídeo fica `failed` (422) | Integridade | ✔ |
| TST-UPLOAD-09 | Componente | Dadas partes fora de ordem, quando o upload é concluído, então as partes são ordenadas e é agendada a inspeção de metadados | Upload multipart | ✔ |
| TST-UPLOAD-10 | Componente | Dada uma sessão ativa, quando é cancelada, então o multipart S3 é abortado e o registo removido | Cancelamento | ✔ |
| TST-UPLOAD-11 | Componente | Dado um vídeo válido, quando a inspeção termina, então a duração, a resolução, os codecs, os FPS e a rotação ficam persistidos e o vídeo fica `ready` | Metadados | ✔ |
| TST-UPLOAD-12 | Componente | Dado um ficheiro inválido, quando a inspeção falha, então o objeto é apagado e o vídeo fica `failed` (invisível na biblioteca) | Limpeza após falha | ✔ |
| TST-UPLOAD-13 | Componente | Dados três uploads concluídos em simultâneo, então os metadados são processados em série e por ordem | Serialização do worker | ✔ |
| TST-META-01 | Componente (ffprobe) | MP4 H.264+AAC aceite, com 320×240, 25 fps e ~10 s | Combinações suportadas | ✔ |
| TST-META-02 | Componente (ffprobe) | MOV H.264 sem áudio aceite (`audioCodec: none`) | Combinações suportadas | ✔ |
| TST-META-03 | Componente (ffprobe) | WebM VP9+Opus aceite | Combinações suportadas | ✔ |
| TST-META-04 | Componente (ffprobe) | MP4 com MPEG-4 Part 2 recusado | Codec não suportado | ✔ |
| TST-META-05 | Componente (ffprobe) | WebM renomeado para `.mp4` recusado | Ficheiro falsificado | ✔ |
| TST-META-06 | Componente (ffprobe) | Ficheiro de texto renomeado para `.mp4` recusado | Ficheiro corrompido | ✔ |
| TST-META-07 | Componente (ffprobe) | O objeto é descarregado para um ficheiro temporário que é sempre apagado, com sucesso ou com falha | Limpeza de temporários | ✔ |
| TST-LIB-01 | Componente | A biblioteca lista só os vídeos `ready` do próprio utilizador, com URL de reprodução | Biblioteca, propriedade | ✔ |
| TST-LIB-02 | Componente | Apagar um vídeo de outro utilizador não tem efeito; apagar um vídeo próprio remove o objeto e o registo | Propriedade | ✔ |

### Recorte (UC-VID-004)

| ID | Tipo | Dado … Quando … Então | Requisito / regra | Resultado |
|----|------|------------------------|-------------------|-----------|
| TST-TRIM-01 | Componente | Uma origem WebM ou HEVC é recusada (400); MOV H.264 é aceite | UC-VID-004/RN2 | ✔ |
| TST-TRIM-02 | Componente | Um vídeo que não está `ready`, ou de outro utilizador, devolve 404 | Propriedade | ✔ |
| TST-TRIM-03 | Componente | Uma origem com mais de 200 MiB é recusada no perfil gratuito e aceite no Premium | REQ-VID-TRIM-NF04 | ✔ |
| TST-TRIM-04 | Componente | `start<0`, `start>=end`, `end>duração`, valores não numéricos → 400; `end == duração` é aceite | REQ-VID-TRIM-NF02 | ✔ |
| TST-TRIM-05 | Componente | 300 s é aceite e 300,5 s recusado (gratuito); 3600 s é aceite e 3601 s recusado (Premium) | REQ-VID-TRIM-NF03 | ✔ |
| TST-TRIM-06 | Componente | Com 1 tarefa ativa: gratuito → 429; Premium aceita até 3 | REQ-VID-TRIM-NF05 | ✔ |
| TST-TRIM-07 | Componente | É criada uma tarefa `queued` com o nome por omissão `<nome>-trim.<ext>`, com `chargedOperation` e o perfil corretos | UC-VID-004 fluxo principal | ✔ |
| TST-TRIM-08 | Componente (ffmpeg) | Recorte 2–5 s por *stream copy* → novo vídeo `ready`, H.264+AAC, com 2,95–3,5 s; o original é mantido | UC-VID-004/RN6 | ✔ |
| TST-TRIM-09 | Componente (ffmpeg) | «Substituir original» atualiza o registo existente e apaga o objeto antigo | UC-VID-004/FA2 | ✔ |
| TST-TRIM-10 | Componente (ffmpeg) | Cancelar durante o processamento → `cancelled`, sem vídeo novo, **1** reembolso | Cancelamento, D-01 | ✔ (falhava antes de `9b79646`) |
| TST-TRIM-11 | Componente | Cancelar em fila → `cancelled`, ffmpeg não é executado, 1 reembolso | Cancelamento | ✔ |
| TST-TRIM-12 | Componente | Uma falha do worker → 1 repetição, depois `failed`, 1 reembolso e temporários removidos | REQ-VID-TRIM-NF12 | ✔ |
| TST-TRIM-13 | Componente (ffmpeg) | Com a quota cheia, o gratuito falha com «Armazenamento insuficiente» e é reembolsado; o Premium com a mesma utilização conclui | Quota, D-02 | ✔ (falhava antes de `9b79646`) |

### Extração de fotogramas (UC-VID-003)

| ID | Tipo | Dado … Quando … Então | Requisito / regra | Resultado |
|----|------|------------------------|-------------------|-----------|
| TST-FRAME-01 | Componente | Uma origem WebM é recusada; MP4 H.264 é aceite | REQ-VID-FRAME-015 | ✔ |
| TST-FRAME-02 | Componente | Os limites de tamanho e de resolução por perfil (1080p gratuito, 4K Premium; 8K sempre recusado) são aplicados | REQ-VID-FRAME-016 | ✔ |
| TST-FRAME-03 | Componente | Intervalo vazio ou fora da duração → 400; 120/121 s (gratuito) e 1800/1801 s (Premium) | REQ-VID-FRAME-005/016 | ✔ |
| TST-FRAME-04 | Componente | O passo tem de ser inteiro entre 1 e 60 s | REQ-VID-FRAME-005 | ✔ |
| TST-FRAME-05 | Componente | 31 fotogramas no gratuito → 400 com a sugestão «passo de pelo menos 3 s»; 200/201 fotogramas no Premium | REQ-VID-FRAME-016, UC-VID-003/RN5 | ✔ |
| TST-FRAME-06 | Componente | GIF é recusado; `JPEG` é normalizado para `jpeg` | REQ-VID-FRAME-035 | ✔ |
| TST-FRAME-07 | Componente | Concorrência só de extrações: gratuito 1, Premium 3; um recorte ativo não conta | REQ-VID-FRAME-021 | ✔ |
| TST-FRAME-08 | Componente | O destino «projeto existente» exige o ID do projeto | UC-VID-003/FA2 | ✔ |
| TST-FRAME-09 | Componente | A tarefa guarda o número de fotogramas calculado (5) e o nome por omissão «<vídeo> - Fotogramas» | REQ-VID-FRAME-005 | ✔ |
| TST-FRAME-10 | Componente (ffmpeg) | 0–4 s, passo 2 → 3 PNG `clip_00-00-0X-000.png` em `user-<id>/<projeto>/src/`, com SHA-256, e o projeto é criado com o token interno | REQ-VID-FRAME-032/040 | ✔ |
| TST-FRAME-11 | Componente (ffmpeg) | 1,5–3,5 s em JPEG para um projeto existente → `append-frames` e nomes `…_00-00-01-500.jpg` | UC-VID-003/FA2, REQ-VID-FRAME-035 | ✔ |
| TST-FRAME-12 | Componente (ffmpeg) | Com o serviço `projects` em baixo → 1 repetição, `failed`, as 6 imagens carregadas são apagadas e há 1 reembolso | REQ-VID-FRAME-046/050 | ✔ |
| TST-FRAME-13 | Componente | Cancelar durante o processamento → `cancelled`, sem projeto, **1** reembolso | Cancelamento, D-01 | ✔ (falhava antes de `9b79646`) |
| TST-FRAME-14 | Componente (ffmpeg) | Com a quota cheia, o gratuito falha; o Premium com a mesma utilização conclui | REQ-VID-FRAME-051, D-02 | ✔ (falhava antes de `9b79646`) |

### Estado das tarefas

| ID | Tipo | Dado … Quando … Então | Requisito / regra | Resultado |
|----|------|------------------------|-------------------|-----------|
| TST-STATUS-01 | Componente | A listagem devolve só as tarefas `queued`/`processing` do utilizador | Acompanhamento de tarefas | ✔ |
| TST-STATUS-02 | Componente | Uma tarefa de outro utilizador devolve 404 | Propriedade | ✔ |
| TST-STATUS-03 | Componente | O cancelamento é encaminhado para o worker do tipo da tarefa | Cancelamento | ✔ |

### API Gateway

| ID | Tipo | Dado … Quando … Então | Requisito / regra | Resultado |
|----|------|------------------------|-------------------|-----------|
| TST-GW-01 | Gateway | Sem JWT, com um JWT inválido ou com um JWT de outro utilizador → 401, sem chamadas internas | Autenticação | ✔ |
| TST-GW-02 | Gateway | Os pedidos são reencaminhados com `x-internal-service-token` | Autenticação interna | ✔ |
| TST-GW-03 | Gateway | Um utilizador anónimo não inicia uploads (403) | Perfis | ✔ |
| TST-GW-04 | Gateway | O perfil vem do serviço `users`, não do corpo do pedido | Dados do cliente não são confiáveis | ✔ |
| TST-GW-05 | Gateway | O upload, a conclusão e o cancelamento não consomem operações diárias | Regra de quota diária | ✔ |
| TST-GW-06 | Gateway | Os erros do `img_storage` são propagados com o código original (413) | — | ✔ |
| TST-GW-TRIM-01..05 | Gateway | Anónimo → 403 sem débito; gratuito → débito antes de criar a tarefa; quota esgotada → 403; erro na criação → reembolso; Premium nunca é debitado | UC-VID-004 | ✔ (5/5) |
| TST-GW-FRAME-01..05 | Gateway | Idem para a extração | UC-VID-003, REQ-VID-FRAME-024 | ✔ (5/5) |

## 3. Testes de sistema (E2E)

Correm contra a stack completa (`imageStorageService/test/e2e/videoApi.e2e.js`).

| ID | Dado … Quando … Então | Resultado |
|----|------------------------|-----------|
| TST-E2E-01 | Um utilizador anónimo não faz upload, recorte nem extração | _por correr_ |
| TST-E2E-02 | MP4, MOV e WebM válidos ficam `ready` com metadados e não consomem operações | _por correr_ |
| TST-E2E-03 | Um ficheiro corrompido → `failed`, objeto apagado no SeaweedFS e ausente da biblioteca | _por correr_ |
| TST-E2E-04 | Um codec não suportado e um contentor falsificado → `failed` e objeto apagado | _por correr_ |
| TST-E2E-05 | Um ficheiro acima do limite do plano é recusado antes de qualquer envio | _por correr_ |
| TST-E2E-06 | Cancelar depois de uma parte aborta o multipart no SeaweedFS | _por correr_ |
| TST-E2E-07 | Um lote de 6 ficheiros enviados em paralelo fica todo `ready` | _por correr_ |
| TST-E2E-08 | A quota total de 1 GiB bloqueia novos uploads (413) | _por correr_ |
| TST-E2E-09 | O recorte cria um vídeo novo e consome 1 operação | _por correr_ |
| TST-E2E-10 | A extração cria um projeto com 3 fotogramas e consome 1 operação | _por correr_ |
| TST-E2E-11 | Cancelar um recorte em fila reembolsa a operação exatamente uma vez | _por correr_ |
| TST-E2E-12 | A 6.ª operação diária de um utilizador gratuito é recusada; o Premium não é limitado | _por correr_ |
| TST-E2E-13 | Um utilizador não lê nem apaga vídeos de outro | _por correr_ |

## 4. Testes manuais (interface)

Executar em `https://localhost:8080` com uma conta gratuita e uma conta Premium.

| ID | Passos | Resultado esperado | Resultado |
|----|--------|--------------------|-----------|
| TST-MAN-01 | Arrastar MP4, MOV e WebM para a biblioteca de vídeos | Barra de progresso, taxa e ETA; os vídeos aparecem com duração e resolução | _por executar_ |
| TST-MAN-02 | Enviar um lote de 6 ficheiros e navegar para outra página do dashboard durante o envio | Os uploads continuam (provider acima das páginas) | _por executar_ |
| TST-MAN-03 | Cancelar um upload grande a meio | O upload para; o vídeo não aparece na biblioteca | _por executar_ |
| TST-MAN-04 | Enviar um `.txt` renomeado para `.mp4` | Toast de erro; o vídeo não aparece | _por executar_ |
| TST-MAN-05 | Recortar um vídeo (sliders), com e sem «Substituir original» | A duração é calculada dinamicamente; a tarefa aparece no monitor; o resultado aparece na biblioteca; o contador de operações desce 1 | _por executar_ |
| TST-MAN-06 | Pedir um recorte acima de 300 s numa conta gratuita | O diálogo impede e explica o limite | _por executar_ |
| TST-MAN-07 | Extrair fotogramas com um número acima de 30 numa conta gratuita | É sugerido o passo mínimo | _por executar_ |
| TST-MAN-08 | Extrair para um projeto novo e abrir o projeto pelo link | O projeto tem as imagens com os nomes `<vídeo>_<hh-mm-ss-mmm>` e as ferramentas de imagem aplicam-se | _por executar_ |
| TST-MAN-09 | Cancelar uma tarefa no monitor | O estado passa a «cancelado» e o contador de operações é reposto | _por executar_ |
| TST-MAN-10 | Esgotar as 5 operações diárias | Mensagem de quota diária e sugestão de Premium | _por executar_ |

## 5. Defeitos e limitações conhecidos

| ID | Tipo | Descrição | Estado |
|----|------|-----------|--------|
| D-01 | Defeito (corrigido) | Reembolso duplicado ao cancelar uma tarefa em processamento | Corrigido em `9b79646`; TST-TRIM-10, TST-FRAME-13 |
| D-02 | Defeito (corrigido) | Quota de armazenamento do worker inferida do vídeo em vez do perfil | Corrigido em `9b79646`; TST-TRIM-13, TST-FRAME-14 |
| L-01 | Limitação | O recorte com *stream copy* corta em fronteiras de pacote/keyframe: o resultado pode ser até ~0,3–0,5 s mais longo do que o pedido (por exemplo, 2–5 s → 3,30 s no contentor, 3,08 s de vídeo) | Por desenho (sem perdas); documentar no relatório |
| L-02 | Limitação | As filas dos workers estão em memória num único processo `img_storage`; após um reinício as tarefas são reagendadas, mas não há escala horizontal | Aceitável no MVP; candidato à Fase 2 |
| L-03 | Limitação | O limite de concorrência do recorte conta tarefas de todos os tipos; o da extração conta só extrações (como especificado em REQ-VID-FRAME-021) | Confirmar com o documento de requisitos |
| T-01 | Baseline | `users`: `POST /users` aceita `type` do cliente (é possível registar uma conta `premium` diretamente) e `GET /users/:id` não exige autenticação | Por corrigir (Cap. 11) |
| T-02 | Baseline | `apiGateway/routes/projects.js:46` — `// TODO Verify jwt` | Por analisar (Cap. 11) |
